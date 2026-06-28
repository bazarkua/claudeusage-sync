import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

export type SupportedOs = "darwin" | "linux" | "win32";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeMachineId(): string {
  const username = userInfo().username || "unknown";
  return sha256(`${hostname()}:${username}`);
}

export function computeHostnameHash(): string {
  return sha256(hostname());
}

export function detectOs(): SupportedOs {
  if (
    process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
  ) {
    return process.platform;
  }

  return "linux";
}
