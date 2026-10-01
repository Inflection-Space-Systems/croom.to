import rateLimit from "express-rate-limit";
/**
 * Authentication routes.
 */

import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import { User } from "../models";
import {
  generateToken,
  AuthRequest,
  authMiddleware,
  requireRole,
} from "../middleware/auth";
import { logger } from "../services/logger";

export const authRouter = Router();
authRouter.use(
  rateLimit({
    windowMs: 900 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests; try again later" },
  }),
);

// Login
authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email ||
      !password ||
      email.length > 255 ||
      Buffer.byteLength(password) > 72
    ) {
      res.status(400).json({ error: "Email and password required" });
      return;
    }

    const user = await User.findOne({ where: { email } });

    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);

    if (!validPassword) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    logger.info(`User ${user.email} logged in`);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    logger.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// Register (admin only in production)
authRouter.post(
  "/register",
  authMiddleware,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const { email, password, name, role } = req.body;

      if (!email || !password || !name) {
        res.status(400).json({ error: "Email, password, and name required" });
        return;
      }

      if (
        typeof email !== "string" ||
        email.length > 255 ||
        typeof name !== "string" ||
        name.length > 255 ||
        typeof password !== "string" ||
        password.length < 16 ||
        Buffer.byteLength(password) > 72 ||
        (role && !["admin", "operator", "viewer"].includes(role))
      ) {
        res.status(400).json({
          error: "Invalid registration fields; password must be 16–72 bytes",
        });
        return;
      }

      // Check if user exists
      const existingUser = await User.findOne({ where: { email } });
      if (existingUser) {
        res.status(409).json({ error: "User already exists" });
        return;
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // Create user
      const user = await User.create({
        email,
        passwordHash,
        name,
        role: role || "viewer",
      });

      logger.info(`User ${user.email} registered`);

      res.status(201).json({
        message: "User created",
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      });
    } catch (error) {
      logger.error("Registration error:", error);
      res.status(500).json({ error: "Registration failed" });
    }
  },
);

// Get current user
authRouter.get(
  "/me",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const user = await User.findByPk(req.user.id);

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      });
    } catch (error) {
      logger.error("Get user error:", error);
      res.status(500).json({ error: "Failed to get user" });
    }
  },
);

// Change password
authRouter.post(
  "/change-password",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: "Current and new password required" });
        return;
      }

      const user = await User.findByPk(req.user.id);

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const validPassword = await bcrypt.compare(
        currentPassword,
        user.passwordHash,
      );

      if (!validPassword) {
        res.status(401).json({ error: "Invalid current password" });
        return;
      }

      if (
        typeof newPassword !== "string" ||
        newPassword.length < 16 ||
        Buffer.byteLength(newPassword) > 72
      ) {
        res.status(400).json({ error: "Password must be 16–72 bytes" });
        return;
      }
      const passwordHash = await bcrypt.hash(newPassword, 12);
      await user.update({ passwordHash });

      logger.info(`User ${user.email} changed password`);

      res.json({ message: "Password changed" });
    } catch (error) {
      logger.error("Change password error:", error);
      res.status(500).json({ error: "Failed to change password" });
    }
  },
);
