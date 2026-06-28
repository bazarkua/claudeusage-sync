import { homedir } from "node:os";
import { resolve } from "node:path";

export function resolveClaudeDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;

  if (override) {
    return resolve(override, "projects");
  }

  return resolve(homedir(), ".claude", "projects");
}
