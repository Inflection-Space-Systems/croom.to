import { Server as HttpServer } from "http";
import { randomUUID } from "crypto";
import WebSocket, { WebSocketServer as WSServer } from "ws";
import { Device, Metrics } from "../models";
import { verifyCredential } from "../services/deviceCredentials";
import { logger } from "../services/logger";

type Result = { success: boolean; data?: unknown; error?: string };
type Connection = { ws: WebSocket; deviceId: string; lastHeartbeat: number };
type Pending = {
  deviceId: string;
  ws: WebSocket;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class WebSocketServer {
  private wss: WSServer;
  private devices = new Map<string, Connection>();
  private pending = new Map<string, Pending>();
  private interval: NodeJS.Timeout;
  constructor(server: HttpServer) {
    this.wss = new WSServer({ server, path: "/ws", maxPayload: 65536 });
    this.wss.on("connection", (ws) => this.connect(ws));
    this.interval = setInterval(() => {
      for (const conn of this.devices.values())
        if (Date.now() - conn.lastHeartbeat > 90000) conn.ws.terminate();
    }, 30000);
  }
  private send(ws: WebSocket, type: string, payload: unknown = {}) {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type, payload }));
  }
  private connect(ws: WebSocket) {
    let connection: Connection | undefined;
    let authenticating = false;
    const authTimeout = setTimeout(
      () => ws.close(1008, "Authentication required"),
      10000,
    );
    this.send(ws, "welcome");
    ws.on("error", () => logger.warn("Device WebSocket transport error"));
    ws.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        const payload = message.payload || {};
        if (!connection) {
          if (message.type !== "auth" || authenticating) {
            this.send(ws, "auth_error");
            ws.close(1008);
            return;
          }
          authenticating = true;
          if (
            typeof payload.deviceId !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(payload.deviceId)
          ) {
            this.send(ws, "auth_error");
            ws.close(1008);
            return;
          }
          const device = await Device.findByPk(payload.deviceId);
          if (
            !device ||
            !verifyCredential(payload.deviceKey, device.deviceKeyHash)
          ) {
            this.send(ws, "auth_error");
            ws.close(1008);
            return;
          }
          if (ws.readyState !== WebSocket.OPEN) return;
          this.devices
            .get(device.id)
            ?.ws.close(1008, "Replaced by new connection");
          connection = { ws, deviceId: device.id, lastHeartbeat: Date.now() };
          this.devices.set(device.id, connection);
          clearTimeout(authTimeout);
          await device.update({ status: "online", lastSeen: new Date() });
          this.send(ws, "auth_success", { deviceId: device.id });
          return;
        }
        // Bind every write to the authenticated connection, never a supplied deviceId.
        if (this.devices.get(connection.deviceId) !== connection) {
          ws.close(1008);
          return;
        }
        const deviceId = connection.deviceId;
        connection.lastHeartbeat = Date.now();
        switch (message.type) {
          case "heartbeat":
            await Device.update(
              { status: "online", lastSeen: new Date() },
              { where: { id: deviceId } },
            );
            this.send(ws, "ack");
            break;
          case "metrics":
            if (
              typeof payload.type !== "string" ||
              payload.type.length > 50 ||
              !payload.data ||
              typeof payload.data !== "object" ||
              Array.isArray(payload.data)
            )
              throw new Error("Invalid metrics");
            await Metrics.create({
              deviceId,
              timestamp: new Date(),
              type: payload.type,
              data: payload.data,
            });
            this.send(ws, "ack");
            break;
          case "command_result": {
            const pending = this.pending.get(payload.requestId);
            if (
              !pending ||
              pending.ws !== ws ||
              pending.deviceId !== deviceId ||
              typeof payload.success !== "boolean"
            )
              throw new Error("Invalid command result");
            clearTimeout(pending.timer);
            this.pending.delete(payload.requestId);
            pending.resolve({
              success: payload.success,
              data: payload.data,
              error:
                typeof payload.error === "string"
                  ? payload.error.slice(0, 255)
                  : undefined,
            });
            break;
          }
          default:
            throw new Error("Unsupported message");
        }
      } catch {
        this.send(ws, "error", { message: "Invalid device message" });
      }
    });
    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (connection && this.devices.get(connection.deviceId) === connection) {
        this.devices.delete(connection.deviceId);
        void Device.update(
          { status: "offline" },
          { where: { id: connection.deviceId } },
        ).catch(() => logger.error("Failed to record disconnect"));
      }
      for (const [id, pending] of this.pending)
        if (pending.ws === ws) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(new Error("Device disconnected"));
        }
    });
  }
  public async command(
    deviceId: string,
    command: string,
    params: unknown,
  ): Promise<Result> {
    const conn = this.devices.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN)
      throw new Error("Device is offline");
    if (this.pending.size >= 100) throw new Error("Too many pending commands");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Device acknowledgement timed out"));
      }, 10000);
      this.pending.set(requestId, {
        deviceId,
        ws: conn.ws,
        resolve,
        reject,
        timer,
      });
      this.send(conn.ws, "command", { requestId, command, params });
    });
  }
  public close() {
    clearInterval(this.interval);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Server shutting down"));
    }
    this.pending.clear();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}
