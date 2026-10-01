import { createHash, randomBytes, timingSafeEqual } from "crypto";
export const createDeviceKey = () => randomBytes(32).toString("hex");
export const hashCredential = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function verifyCredential(
  value: unknown,
  hash: string | null | undefined,
): boolean {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(hashCredential(value), "hex"),
    Buffer.from(hash, "hex"),
  );
}
