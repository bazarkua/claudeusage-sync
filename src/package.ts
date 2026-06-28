import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PackageInfo = {
  version: string;
};

export function readPackageInfo(metaUrl: string): PackageInfo {
  let dir = dirname(fileURLToPath(metaUrl));
  let packagePath = resolve(dir, "package.json");

  for (let depth = 0; depth < 6 && !existsSync(packagePath); depth += 1) {
    dir = resolve(dir, "..");
    packagePath = resolve(dir, "package.json");
  }

  const raw = readFileSync(packagePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<PackageInfo>;

  return {
    version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
  };
}
