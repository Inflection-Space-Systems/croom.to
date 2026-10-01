"""Management-only trial; deliberately does not start audio/video/meeting services."""

import argparse
import asyncio
import json
import logging
import os
import platform
import shutil
import signal
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import aiohttp
import yaml

logger = logging.getLogger(__name__)


class TrialManagementAgent:
    def __init__(self, config_path: Path, state_path: Path, *, allow_insecure_localhost=False):
        self.config_path = Path(config_path)
        self.state_path = Path(state_path)
        with self.config_path.open() as stream:
            config = yaml.safe_load(stream)
        if not isinstance(config, dict) or not isinstance(config.get("dashboard"), dict):
            raise ValueError("A dashboard configuration is required")
        self.dashboard = config["dashboard"]
        self.url = self.dashboard.get("url", "").rstrip("/")
        parsed = urlsplit(self.url)
        local = allow_insecure_localhost and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path
            or (parsed.scheme != "https" and not (parsed.scheme == "http" and local))
        ):
            raise ValueError("Dashboard URL must be an HTTPS origin")
        self.heartbeat = self.dashboard.get("heartbeat_interval_seconds", 30)
        self.metrics_interval = self.dashboard.get("metrics_interval_seconds", 60)
        if (
            not isinstance(self.heartbeat, int)
            or not 1 <= self.heartbeat <= 60
            or not isinstance(self.metrics_interval, int)
            or not 1 <= self.metrics_interval <= 3600
        ):
            raise ValueError("Invalid heartbeat or metrics interval")
        self.room = dict(config.get("room") or {"name": platform.node()})
        self.identity = None
        if self.state_path.exists():
            # Credentials must be private even if manually restored from backup.
            if self.state_path.stat().st_mode & 0o077:
                raise ValueError("Dashboard state permissions must be 0600")
            state = json.loads(self.state_path.read_text())
            if (
                state.get("dashboardUrl") != self.url
                or not state.get("deviceId")
                or not state.get("deviceKey")
            ):
                raise ValueError(
                    "State belongs to another dashboard or is invalid; re-enroll explicitly"
                )
            self.identity = state
            self.room.update(state.get("room", {}))

    def _save(self, room):
        self.state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        record = {**(self.identity or {}), "dashboardUrl": self.url, "room": room}
        fd, name = tempfile.mkstemp(dir=self.state_path.parent, prefix=".croom-state-")
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(record, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.state_path)
            # Persist the directory entry before acknowledging configuration.
            directory = os.open(self.state_path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    async def _enroll(self, session):
        token = self.dashboard.get("enrollment_token")
        if not token:
            raise RuntimeError("Enrollment token is required for first enrollment")
        async with session.post(
            self.url + "/api/provisioning/enroll",
            json={
                "token": token,
                "deviceInfo": {
                    "name": platform.node(),
                    "platform": platform.machine(),
                    "softwareVersion": "2.0.0-management-trial",
                    "capabilities": {"managementOnly": True},
                },
            },
            allow_redirects=False,
        ) as response:
            if response.status != 200:
                raise RuntimeError("Enrollment failed; generate a fresh token")
            identity = await response.json()
        if not identity.get("deviceId") or not identity.get("deviceKey"):
            raise RuntimeError("Invalid enrollment response")
        self.identity = {
            "deviceId": identity["deviceId"],
            "deviceKey": identity["deviceKey"],
            "dashboardUrl": self.url,
        }
        self._save(self.room)

    def status(self):
        disk = shutil.disk_usage(self.state_path.parent if self.state_path.parent.exists() else "/")
        metrics = {
            "hostname": platform.node(),
            "architecture": platform.machine(),
            "managementOnly": True,
            "room": self.room,
            "loadAverage": list(os.getloadavg()),
            "diskUsedPercent": round(disk.used / disk.total * 100, 1),
        }
        try:
            metrics["temperatureC"] = (
                int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000
            )
        except (OSError, ValueError):
            pass
        try:
            memory = dict(
                line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines()
            )
            total = int(memory["MemTotal"].split()[0])
            metrics["memoryUsedPercent"] = round(
                (1 - int(memory["MemAvailable"].split()[0]) / total) * 100, 1
            )
        except (OSError, KeyError, ValueError, ZeroDivisionError):
            pass
        return metrics

    async def command(self, payload):
        try:
            if payload.get("command") == "get_status":
                return {"success": True, "data": self.status()}
            if payload.get("command") != "configure_room":
                return {"success": False, "error": "Unsupported trial command"}
            room = payload.get("params")
            if (
                not isinstance(room, dict)
                or not room
                or any(
                    key not in {"name", "location", "timezone"}
                    or not isinstance(value, str)
                    or len(value) > 255
                    for key, value in room.items()
                )
            ):
                raise ValueError("Invalid room fields")
            if "name" in room and not room["name"].strip():
                raise ValueError("Room name is empty")
            if "timezone" in room:
                ZoneInfo(room["timezone"])
            updated = {**self.room, **room}
            self._save(updated)
            self.room = updated
            return {"success": True}
        except Exception:
            logger.warning("Room configuration could not be persisted")
            return {
                "success": False,
                "error": "Invalid room configuration or state is not writable",
            }

    async def _send_periodic(self, ws):
        last_metrics = None
        while not ws.closed:
            await ws.send_json({"type": "heartbeat", "payload": {}})
            now = asyncio.get_running_loop().time()
            if last_metrics is None or now - last_metrics >= self.metrics_interval:
                await ws.send_json(
                    {"type": "metrics", "payload": {"type": "system", "data": self.status()}}
                )
                last_metrics = now
            await asyncio.sleep(self.heartbeat)

    async def _connect(self, session, stop):
        ws_url = self.url.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/ws"
        async with session.ws_connect(ws_url, max_msg_size=65536, heartbeat=30) as ws:
            await ws.send_json(
                {
                    "type": "auth",
                    "payload": {
                        "deviceId": self.identity["deviceId"],
                        "deviceKey": self.identity["deviceKey"],
                    },
                }
            )

            async def authenticate():
                while True:
                    reply = await ws.receive_json()
                    if reply.get("type") == "auth_success":
                        break
                    if reply.get("type") != "welcome":
                        raise RuntimeError("Dashboard authentication failed")

            await asyncio.wait_for(authenticate(), timeout=10)
            logger.info("Management trial connected")
            sender = asyncio.create_task(self._send_periodic(ws))
            stopper = asyncio.create_task(stop.wait())

            async def receive():
                async for message in ws:
                    if message.type != aiohttp.WSMsgType.TEXT:
                        continue
                    data = json.loads(message.data)
                    if data.get("type") == "command":
                        payload = data.get("payload", {})
                        result = await self.command(payload)
                        await ws.send_json(
                            {
                                "type": "command_result",
                                "payload": {"requestId": payload.get("requestId"), **result},
                            }
                        )

            receiver = asyncio.create_task(receive())
            try:
                done, _ = await asyncio.wait(
                    {sender, stopper, receiver}, return_when=asyncio.FIRST_COMPLETED
                )
                for task in done:
                    task.result()
            finally:
                for task in (sender, stopper, receiver):
                    task.cancel()
                await asyncio.gather(sender, stopper, receiver, return_exceptions=True)

    async def run(self, stop):
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=30, connect=10)
        ) as session:
            if not self.identity:
                await self._enroll(session)
            while not stop.is_set():
                try:
                    await self._connect(session, stop)
                except (
                    aiohttp.ClientError,
                    OSError,
                    RuntimeError,
                    ValueError,
                    asyncio.TimeoutError,
                ):
                    logger.warning("Dashboard connection unavailable; retrying")
                if not stop.is_set():
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        pass


async def run_agent(args):
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await TrialManagementAgent(
        args.config, args.state, allow_insecure_localhost=args.allow_insecure_localhost
    ).run(stop)


def main():
    parser = argparse.ArgumentParser(
        description="Croom management-only trial (no meeting services)"
    )
    parser.add_argument("-c", "--config", type=Path, required=True)
    parser.add_argument(
        "--state", type=Path, default=Path("/var/lib/croom/trial-management/identity.json")
    )
    parser.add_argument(
        "--allow-insecure-localhost",
        action="store_true",
        help="Permit HTTP only on loopback for local tests",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(run_agent(args))
    except (OSError, ValueError, RuntimeError):
        logger.error(
            "Management trial startup failed; check config, enrollment and state permissions"
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
