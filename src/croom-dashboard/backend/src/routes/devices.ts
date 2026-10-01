import { Router } from "express";
import { Device, sequelize } from "../models";
import { requireRole } from "../middleware/auth";
import { WebSocketServer } from "../websocket/server";

export function createDeviceRouter(gateway: WebSocketServer) {
  const router = Router();
  const view = (d: Device) => ({
    id: d.id,
    name: d.name,
    roomName: d.roomName,
    location: d.location,
    status: d.status,
    platform: d.platform,
    softwareVersion: d.softwareVersion,
    lastSeen: d.lastSeen,
    capabilities: d.capabilities,
    config: d.config,
  });
  router.get("/", async (_req, res) => {
    try {
      const devices = await Device.findAll({ order: [["roomName", "ASC"]] });
      res.json({ devices: devices.map(view), total: devices.length });
    } catch {
      res.status(500).json({ error: "Failed to list devices" });
    }
  });
  router.get("/summary/status", async (_req, res) => {
    try {
      const devices = await Device.findAll();
      res.json({
        total: devices.length,
        online: devices.filter((d) => d.status === "online").length,
        offline: devices.filter((d) => d.status === "offline").length,
        error: devices.filter((d) => d.status === "error").length,
        provisioning: devices.filter((d) => d.status === "provisioning").length,
      });
    } catch {
      res.status(500).json({ error: "Failed to get summary" });
    }
  });
  router.param("id", (_req, res, next, id) => {
    if (!/^[a-f0-9-]{36}$/i.test(id)) {
      res.status(400).json({ error: "Invalid device ID" });
      return;
    }
    next();
  });
  router.get("/:id", async (req, res) => {
    try {
      const device = await Device.findByPk(req.params.id);
      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      res.json(view(device));
    } catch {
      res.status(500).json({ error: "Failed to get device" });
    }
  });
  router.put("/:id", requireRole("admin", "operator"), async (req, res) => {
    const room = req.body.config?.room;
    const allowed = ["name", "location", "timezone"];
    if (
      !room ||
      typeof room !== "object" ||
      Array.isArray(room) ||
      Object.keys(req.body).some((k) => k !== "config") ||
      Object.keys(req.body.config).some((k) => k !== "room") ||
      Object.keys(room).length === 0 ||
      Object.keys(room).some(
        (k) =>
          !allowed.includes(k) ||
          typeof room[k] !== "string" ||
          room[k].length > 255,
      ) ||
      (room.name !== undefined && !room.name.trim())
    ) {
      res
        .status(400)
        .json({ error: "Trial accepts room name, location and timezone only" });
      return;
    }
    if (room.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: room.timezone });
      } catch {
        res.status(400).json({ error: "Invalid timezone" });
        return;
      }
    }
    try {
      // Serialize config writes for a device through durable acknowledgement.
      const device = await sequelize.transaction(async (transaction) => {
        const device = await Device.findByPk(req.params.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!device) return null;
        const result = await gateway.command(device.id, "configure_room", room);
        if (!result.success) throw new Error("Device rejected configuration");
        const current = device.config as { room?: object };
        await device.update(
          {
            config: { ...current, room: { ...current.room, ...room } },
            ...(room.name !== undefined ? { roomName: room.name } : {}),
            ...(room.location !== undefined ? { location: room.location } : {}),
          },
          { transaction },
        );
        return device;
      });
      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      res.json({
        message: "Configuration applied by device",
        device: view(device),
      });
    } catch (error) {
      res
        .status(409)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "Configuration delivery failed",
        });
    }
  });
  router.post(
    "/:id/command",
    requireRole("admin", "operator"),
    async (req, res) => {
      if (req.body.command !== "get_status") {
        res
          .status(400)
          .json({
            error:
              "Trial supports get_status; reboot and software updates are unavailable",
          });
        return;
      }
      try {
        const result = await gateway.command(req.params.id, "get_status", {});
        res.status(result.success ? 200 : 409).json(result);
      } catch {
        res
          .status(409)
          .json({ error: "Device unavailable or acknowledgement timed out" });
      }
    },
  );
  return router;
}
