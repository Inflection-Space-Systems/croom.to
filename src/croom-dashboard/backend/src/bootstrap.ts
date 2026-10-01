import "dotenv/config";
import bcrypt from "bcrypt";
import { sequelize, User } from "./models";

// Initial schema creation only. No alter/force: existing data is never dropped.
async function bootstrap() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (
    !email ||
    email.length > 255 ||
    !password ||
    password.length < 16 ||
    Buffer.byteLength(password) > 72
  ) {
    throw new Error(
      "Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (16–72 bytes)",
    );
  }
  await sequelize.sync();
  const existing = await User.findOne({ where: { email } });
  if (existing) {
    if (existing.role !== "admin")
      throw new Error("Bootstrap account exists without administrator role");
  } else {
    await User.create({
      email,
      name: "Trial Administrator",
      passwordHash: await bcrypt.hash(password, 12),
      role: "admin",
    });
  }
}
bootstrap()
  .catch(() => {
    console.error("Bootstrap failed; check database and bootstrap credentials");
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
