import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from aiohttp import web
from aiohttp.test_utils import TestServer
import yaml
from croom.trial_management import TrialManagementAgent


class ManagementTrialTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Path(self.temp.name) / "config.yaml"
        self.state = Path(self.temp.name) / "state" / "identity.json"
        self.enrollments = 0
        self.metrics = asyncio.Event()
        self.result = asyncio.Future()

        async def enroll(request):
            self.enrollments += 1
            data = await request.json()
            if data["token"] != "valid-token":
                return web.json_response({}, status=401)
            return web.json_response({"deviceId": "device-test", "deviceKey": "secret-device-key"})

        async def socket(request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.send_json({"type": "welcome"})
            auth = await ws.receive_json()
            self.assertEqual(auth["payload"]["deviceKey"], "secret-device-key")
            await ws.send_json({"type": "auth_success"})
            await ws.send_json(
                {
                    "type": "command",
                    "payload": {
                        "requestId": "config-1",
                        "command": "configure_room",
                        "params": {"name": "Managed Room", "timezone": "America/Denver"},
                    },
                }
            )
            async for message in ws:
                data = json.loads(message.data)
                if data["type"] == "metrics":
                    self.metrics.set()
                if data["type"] == "command_result" and not self.result.done():
                    self.result.set_result(data["payload"])
            return ws

        app = web.Application()
        app.router.add_post("/api/provisioning/enroll", enroll)
        app.router.add_get("/ws", socket)
        self.server = TestServer(app)
        await self.server.start_server()
        self.url = str(self.server.make_url("")).rstrip("/")
        self.raw = {
            "room": {"name": "Original"},
            "dashboard": {"url": self.url, "enrollment_token": "valid-token"},
        }
        self.config.write_text(yaml.safe_dump(self.raw))

    async def asyncTearDown(self):
        await self.server.close()
        self.temp.cleanup()

    def agent(self):
        return TrialManagementAgent(self.config, self.state, allow_insecure_localhost=True)

    async def test_enrollment_persistence_metrics_and_config_acknowledgement(self):
        agent = self.agent()
        stop = asyncio.Event()
        task = asyncio.create_task(agent.run(stop))
        try:
            result = await asyncio.wait_for(self.result, 5)
            self.assertTrue(result["success"])
            await asyncio.wait_for(self.metrics.wait(), 5)
            stored = json.loads(self.state.read_text())
            self.assertEqual(stored["room"]["name"], "Managed Room")
            self.assertEqual(os.stat(self.state).st_mode & 0o777, 0o600)
            self.assertEqual(yaml.safe_load(self.config.read_text()), self.raw)
            restarted = self.agent()
            self.assertEqual(restarted.room["name"], "Managed Room")
            self.assertEqual(restarted.identity["deviceKey"], "secret-device-key")
            self.assertEqual(self.enrollments, 1)
        finally:
            stop.set()
            await asyncio.wait_for(task, 5)

    async def test_invalid_token_does_not_persist_identity(self):
        self.raw["dashboard"]["enrollment_token"] = "invalid"
        self.config.write_text(yaml.safe_dump(self.raw))
        with self.assertRaises(RuntimeError):
            await self.agent().run(asyncio.Event())
        self.assertFalse(self.state.exists())

    async def test_remote_commands_cannot_run_arbitrary_programs(self):
        agent = self.agent()
        result = await agent.command(
            {"command": "shell", "params": {"command": "touch /tmp/unsafe"}}
        )
        self.assertFalse(result["success"])

    async def test_failed_durable_write_does_not_acknowledge_or_change_effective_room(self):
        agent = self.agent()
        with patch.object(agent, "_save", side_effect=OSError("read-only")):
            result = await agent.command({"command": "configure_room", "params": {"name": "New"}})
        self.assertFalse(result["success"])
        self.assertEqual(agent.room["name"], "Original")

    async def test_unknown_room_fields_and_bad_timezone_are_rejected(self):
        agent = self.agent()
        for params in [{"password": "oops"}, {"timezone": "not-a-timezone"}, {"name": ""}]:
            self.assertFalse(
                (await agent.command({"command": "configure_room", "params": params}))["success"]
            )

    async def test_credentials_cannot_be_sent_to_a_changed_dashboard(self):
        agent = self.agent()
        agent.identity = {"deviceId": "x", "deviceKey": "secret", "dashboardUrl": self.url}
        agent._save(agent.room)
        self.raw["dashboard"]["url"] = "https://other.example.test"
        self.config.write_text(yaml.safe_dump(self.raw))
        with self.assertRaises(ValueError):
            self.agent()

    async def test_plain_http_requires_explicit_localhost_exception(self):
        with self.assertRaises(ValueError):
            TrialManagementAgent(self.config, self.state)
        self.raw["dashboard"]["url"] = "http://192.168.1.1"
        self.config.write_text(yaml.safe_dump(self.raw))
        with self.assertRaises(ValueError):
            self.agent()

    async def test_read_status_excludes_credentials(self):
        agent = self.agent()
        agent.identity = {"deviceKey": "secret", "deviceId": "test"}
        result = await agent.command({"command": "get_status"})
        self.assertTrue(result["success"])
        self.assertNotIn("secret", json.dumps(result))
