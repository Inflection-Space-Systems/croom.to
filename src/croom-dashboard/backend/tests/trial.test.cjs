const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const WebSocket = require("ws");
const bcrypt = require("bcrypt");
if (!process.env.DB_NAME?.endsWith("_test"))
  throw new Error("Use a disposable *_test database");
process.env.JWT_SECRET = "test-only-signing-secret-at-least-32-characters";
const { sequelize, User, Device, Metrics } = require("../dist/models");
const { createDashboardServer } = require("../dist/app");
let server, gateway, base, admin, enrollment, identity, ws;
async function request(path, body, token, method = "POST") {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json() };
}
function nextMessage(socket) {
  return once(socket, "message").then(([data]) => JSON.parse(data));
}
before(async () => {
  await sequelize.sync({ force: true });
  await User.create({
    name: "Trial Admin",
    email: "admin@example.test",
    passwordHash: await bcrypt.hash("test-admin-password-12345", 4),
    role: "admin",
  });
  ({ server, gateway } = createDashboardServer());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  ws?.terminate();
  gateway?.close();
  if (server) await new Promise((r) => server.close(r));
  await sequelize.close();
});
test("administrator registration and device inventory require authentication", async () => {
  assert.equal(
    (
      await request("/api/auth/register", {
        name: "Intruder",
        email: "bad@example.test",
        password: "a-long-enough-password",
        role: "admin",
      })
    ).status,
    401,
  );
  assert.equal(
    (await request("/api/devices", undefined, undefined, "GET")).status,
    401,
  );
  const login = await request("/api/auth/login", {
    email: "admin@example.test",
    password: "test-admin-password-12345",
  });
  assert.equal(login.status, 200);
  admin = login.data.token;
  const viewer = await request(
    "/api/auth/register",
    {
      name: "Viewer",
      email: "viewer@example.test",
      password: "viewer-password-long",
      role: "viewer",
    },
    admin,
  );
  assert.equal(viewer.status, 201);
  const viewerLogin = await request("/api/auth/login", {
    email: "viewer@example.test",
    password: "viewer-password-long",
  });
  assert.equal(
    (
      await request(
        "/api/provisioning/token",
        { roomName: "Forbidden" },
        viewerLogin.data.token,
      )
    ).status,
    403,
  );
});
test("enrollment tokens expire and may only be exchanged once; keys are hashed at rest", async () => {
  const expired = await request(
    "/api/provisioning/token",
    { roomName: "Expired" },
    admin,
  );
  await Device.update(
    { enrollmentExpiresAt: new Date(0) },
    { where: { id: expired.data.deviceId } },
  );
  assert.equal(
    (await request("/api/provisioning/enroll", { token: expired.data.token }))
      .status,
    401,
  );
  enrollment = await request(
    "/api/provisioning/token",
    { roomName: "Holocan", location: "Trial" },
    admin,
  );
  assert.equal(enrollment.status, 201);
  const enrolled = await request("/api/provisioning/enroll", {
    token: enrollment.data.token,
    deviceInfo: {
      name: "holocan",
      platform: "aarch64",
      softwareVersion: "trial",
    },
  });
  assert.equal(enrolled.status, 200);
  identity = enrolled.data;
  assert.equal(
    (
      await request("/api/provisioning/enroll", {
        token: enrollment.data.token,
      })
    ).status,
    401,
  );
  const stored = await Device.findByPk(identity.deviceId);
  assert.notEqual(stored.deviceKeyHash, identity.deviceKey);
  assert.equal(stored.enrollmentToken, null);
});
test("WebSocket rejects spoofed credentials and unauthenticated metrics", async () => {
  const bad = new WebSocket(base.replace("http:", "ws:") + "/ws");
  const welcome = nextMessage(bad);
  await once(bad, "open");
  await welcome;
  let reply = nextMessage(bad);
  bad.send(
    JSON.stringify({
      type: "metrics",
      payload: {
        deviceId: identity.deviceId,
        type: "system",
        data: { cpu: 99 },
      },
    }),
  );
  assert.equal((await reply).type, "auth_error");
  await once(bad, "close");
  assert.equal(await Metrics.count(), 0);
  const spoof = new WebSocket(base.replace("http:", "ws:") + "/ws");
  const greeting = nextMessage(spoof);
  await once(spoof, "open");
  await greeting;
  reply = nextMessage(spoof);
  spoof.send(
    JSON.stringify({
      type: "auth",
      payload: { deviceId: identity.deviceId, deviceKey: "wrong-key" },
    }),
  );
  assert.equal((await reply).type, "auth_error");
  await once(spoof, "close");
});
test("authenticated device reports metrics and acknowledges configuration delivery", async () => {
  ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
  const welcome = nextMessage(ws);
  await once(ws, "open");
  await welcome;
  let reply = nextMessage(ws);
  ws.send(JSON.stringify({ type: "auth", payload: identity }));
  assert.equal((await reply).type, "auth_success");
  reply = nextMessage(ws);
  ws.send(
    JSON.stringify({
      type: "metrics",
      payload: {
        deviceId: "spoofed-id",
        type: "system",
        data: { temperature: 45 },
      },
    }),
  );
  assert.equal((await reply).type, "ack");
  const metric = await Metrics.findOne();
  assert.equal(metric.deviceId, identity.deviceId);
  const command = nextMessage(ws);
  const update = request(
    `/api/devices/${identity.deviceId}`,
    {
      config: {
        room: {
          name: "Trial Room",
          location: "Office",
          timezone: "America/Denver",
        },
      },
    },
    admin,
    "PUT",
  );
  const message = await command;
  assert.equal(message.type, "command");
  assert.equal(message.payload.command, "configure_room");
  ws.send(
    JSON.stringify({
      type: "command_result",
      payload: { requestId: message.payload.requestId, success: true },
    }),
  );
  assert.equal((await update).status, 200);
  assert.equal(
    (await Device.findByPk(identity.deviceId)).config.room.name,
    "Trial Room",
  );
  assert.equal(
    (
      await request(
        `/api/devices/${identity.deviceId}/command`,
        { command: "reboot" },
        admin,
      )
    ).status,
    400,
  );
});
test("disconnect is visible and config changes to an offline device do not report success", async () => {
  const closed = once(ws, "close");
  ws.close();
  await closed;
  for (
    let i = 0;
    i < 20 && (await Device.findByPk(identity.deviceId)).status !== "offline";
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.equal((await Device.findByPk(identity.deviceId)).status, "offline");
  assert.equal(
    (
      await request(
        `/api/devices/${identity.deviceId}`,
        { config: { room: { name: "Offline edit" } } },
        admin,
        "PUT",
      )
    ).status,
    409,
  );
});

test("repeated unauthenticated login attempts are rate limited", async () => {
  let status;
  for (let i = 0; i < 22; i++) {
    status = (
      await request("/api/auth/login", {
        email: "unknown@example.test",
        password: "wrong-password",
      })
    ).status;
    if (status === 429) break;
  }
  assert.equal(status, 429);
});
