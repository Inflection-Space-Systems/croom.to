import { Router, Response } from "express";
import { Device, sequelize } from "../models";
import { authMiddleware, AuthRequest, requireRole } from "../middleware/auth";
import { createDeviceKey, hashCredential } from "../services/deviceCredentials";

export const provisioningRouter = Router();
provisioningRouter.post(
  "/token",
  authMiddleware,
  requireRole("admin"),
  async (req: AuthRequest, res: Response) => {
    const { roomName, location = "", expiresInHours = 24 } = req.body;
    if (
      typeof roomName !== "string" ||
      !roomName.trim() ||
      roomName.length > 255 ||
      typeof location !== "string" ||
      location.length > 255 ||
      typeof expiresInHours !== "number" ||
      !Number.isFinite(expiresInHours) ||
      expiresInHours <= 0 ||
      expiresInHours > 168
    ) {
      res
        .status(400)
        .json({
          error: "Invalid room, location or token lifetime (maximum 168 hours)",
        });
      return;
    }
    try {
      const token = createDeviceKey();
      const expiresAt = new Date(Date.now() + expiresInHours * 3600000);
      const device = await Device.create({
        name: roomName,
        roomName,
        location,
        status: "provisioning",
        platform: "unknown",
        softwareVersion: "unknown",
        enrollmentToken: hashCredential(token),
        enrollmentExpiresAt: expiresAt,
      });
      res
        .status(201)
        .json({
          token,
          deviceId: device.id,
          roomName,
          expiresAt,
          enrollmentUrl: `${process.env.BASE_URL || ""}/api/provisioning/enroll`,
        });
    } catch {
      res.status(500).json({ error: "Failed to create token" });
    }
  },
);

provisioningRouter.post("/enroll", async (req, res) => {
  const { token, deviceInfo = {} } = req.body;
  if (
    typeof token !== "string" ||
    token.length > 256 ||
    !token ||
    !deviceInfo ||
    typeof deviceInfo !== "object"
  ) {
    res.status(400).json({ error: "Invalid enrollment request" });
    return;
  }
  for (const key of ["name", "platform", "softwareVersion"]) {
    if (
      deviceInfo[key] !== undefined &&
      (typeof deviceInfo[key] !== "string" ||
        deviceInfo[key].length > (key === "name" ? 255 : 50))
    ) {
      res.status(400).json({ error: "Invalid device information" });
      return;
    }
  }
  try {
    // Lock while consuming: two simultaneous enrollments cannot exchange the same token.
    const result = await sequelize.transaction(async (transaction) => {
      const device = await Device.findOne({
        where: { enrollmentToken: hashCredential(token) },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        !device ||
        device.status !== "provisioning" ||
        !device.enrollmentExpiresAt ||
        device.enrollmentExpiresAt.getTime() <= Date.now()
      )
        return null;
      const deviceKey = createDeviceKey();
      await device.update(
        {
          name: deviceInfo.name || device.name,
          platform: deviceInfo.platform || "unknown",
          softwareVersion: deviceInfo.softwareVersion || "unknown",
          capabilities: deviceInfo.capabilities || {},
          status: "offline",
          enrollmentToken: null,
          enrollmentExpiresAt: null,
          deviceKeyHash: hashCredential(deviceKey),
        },
        { transaction },
      );
      return { deviceId: device.id, deviceKey, config: device.config };
    });
    if (!result) {
      res.status(401).json({ error: "Invalid or expired enrollment token" });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: "Enrollment failed" });
  }
});

provisioningRouter.get(
  "/pending",
  authMiddleware,
  requireRole("admin"),
  async (_req, res) => {
    try {
      const devices = await Device.findAll({
        where: { status: "provisioning" },
        order: [["createdAt", "DESC"]],
      });
      res.json({
        pendingDevices: devices.map((d) => ({
          id: d.id,
          roomName: d.roomName,
          location: d.location,
          createdAt: d.createdAt,
          expiresAt: d.enrollmentExpiresAt,
        })),
      });
    } catch {
      res.status(500).json({ error: "Failed to list pending devices" });
    }
  },
);
provisioningRouter.delete(
  "/token/:deviceId",
  authMiddleware,
  requireRole("admin"),
  async (req, res) => {
    try {
      const removed = await Device.destroy({
        where: { id: req.params.deviceId, status: "provisioning" },
      });
      res
        .status(removed ? 200 : 404)
        .json({
          message: removed
            ? "Enrollment cancelled"
            : "Pending enrollment not found",
        });
    } catch {
      res.status(400).json({ error: "Invalid device ID" });
    }
  },
);
