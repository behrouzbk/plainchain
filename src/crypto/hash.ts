import { createHash } from "node:crypto";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function doubleSha256(data: string | Buffer): string {
  return sha256(sha256(data));
}
