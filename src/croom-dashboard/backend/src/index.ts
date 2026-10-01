import "dotenv/config";
import { initDatabase, sequelize } from "./models";
import { createDashboardServer } from "./app";
import { logger } from "./services/logger";
async function main() {
  await initDatabase();
  const { server, gateway } = createDashboardServer();
  server.listen(
    Number(process.env.PORT || 3001),
    process.env.HOST || "0.0.0.0",
    () => logger.info("Dashboard API listening"),
  );
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    gateway.close();
    server.close(() => {
      void sequelize.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
main().catch(() => {
  logger.error("Dashboard startup failed");
  process.exit(1);
});
