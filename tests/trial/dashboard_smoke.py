"""Exercise the trial agent against a local disposable Node/PostgreSQL dashboard."""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
import aiohttp
import yaml
from croom.trial_management import TrialManagementAgent


async def smoke():
    url = os.environ["TRIAL_DASHBOARD_URL"].rstrip("/")
    if urlsplit(url).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("This smoke test is restricted to a disposable local dashboard")
    async with aiohttp.ClientSession() as session:
        async with session.post(
            url + "/api/auth/login",
            json={
                "email": os.environ["TRIAL_ADMIN_EMAIL"],
                "password": os.environ["TRIAL_ADMIN_PASSWORD"],
            },
        ) as response:
            assert response.status == 200
            token = (await response.json())["token"]
        headers = {"Authorization": "Bearer " + token}
        async with session.post(
            url + "/api/provisioning/token", headers=headers, json={"roomName": "Integration trial"}
        ) as response:
            assert response.status == 201
            enrollment = await response.json()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            config = path / "config.yaml"
            config.write_text(
                yaml.safe_dump(
                    {
                        "room": {"name": "Integration trial"},
                        "dashboard": {
                            "url": url,
                            "enrollment_token": enrollment["token"],
                            "heartbeat_interval_seconds": 1,
                            "metrics_interval_seconds": 1,
                        },
                    }
                )
            )
            state = path / "state" / "identity.json"
            agent = TrialManagementAgent(config, state, allow_insecure_localhost=True)
            stop = asyncio.Event()
            task = asyncio.create_task(agent.run(stop))
            try:

                async def wait_online():
                    while True:
                        async with session.get(
                            url + "/api/devices/" + enrollment["deviceId"], headers=headers
                        ) as response:
                            device = await response.json()
                        if device["status"] == "online":
                            break
                        await asyncio.sleep(0.1)

                await asyncio.wait_for(wait_online(), timeout=15)
                async with session.put(
                    url + "/api/devices/" + enrollment["deviceId"],
                    headers=headers,
                    json={
                        "config": {"room": {"name": "Confirmed room", "timezone": "America/Denver"}}
                    },
                ) as response:
                    assert response.status == 200, await response.text()
                assert json.loads(state.read_text())["room"]["name"] == "Confirmed room"
                async with session.post(
                    url + "/api/devices/" + enrollment["deviceId"] + "/command",
                    headers=headers,
                    json={"command": "get_status"},
                ) as response:
                    assert response.status == 200
                    status = await response.json()
                    assert status["data"]["room"]["name"] == "Confirmed room"
                    assert status["data"]["managementOnly"] is True
                await asyncio.sleep(1.2)
                async with session.get(
                    url + "/api/metrics/device/" + enrollment["deviceId"], headers=headers
                ) as response:
                    assert len((await response.json())["metrics"]) > 0
                assert (
                    TrialManagementAgent(config, state, allow_insecure_localhost=True).room["name"]
                    == "Confirmed room"
                )
                print(
                    "PASS: enrollment, online status, durable configuration, remote status, metrics and restart state"
                )
            finally:
                stop.set()
                await asyncio.wait_for(task, 5)


if __name__ == "__main__":
    asyncio.run(smoke())
