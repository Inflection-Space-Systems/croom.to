import rateLimit from "express-rate-limit";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import { createServer } from "http";
import { sequelize } from "./models";
import { WebSocketServer } from "./websocket/server";
import { createDeviceRouter } from "./routes/devices";
import { authRouter } from "./routes/auth";
import { metricsRouter } from "./routes/metrics";
import { provisioningRouter } from "./routes/provisioning";
import { errorHandler } from "./middleware/errorHandler";
import { authMiddleware } from "./middleware/auth";

export function createDashboardServer() {
  const app = express();
  const server = createServer(app);
  const gateway = new WebSocketServer(server);
  app.set("trust proxy", process.env.TRUST_PROXY_HOPS === "1" ? 1 : false);
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests; try again later" },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
  app.use(compression());
  app.use(morgan("short"));
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_req, res) => res.json({ status: "healthy" }));
  app.get("/ready", async (_req, res) => {
    try {
      await sequelize.authenticate();
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use("/api/auth", authRouter);
  app.use("/api/provisioning", provisioningRouter);
  app.use("/api/devices", authMiddleware, createDeviceRouter(gateway));
  app.use("/api/metrics", authMiddleware, metricsRouter);
  app.use(errorHandler);
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return { server, gateway };
}
