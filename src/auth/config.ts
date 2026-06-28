import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  apiBase: z.string().url(),
  consentAcceptedAt: z.string().optional(),
  lastSyncAt: z.string().optional(),
  lastSyncMessageId: z.string().optional(),
  token: z.string().regex(/^cu_live_[a-f0-9]{48}$/),
});

export type Config = z.infer<typeof configSchema>;

export function configDir(): string {
  return resolve(process.env.CLAUDEUSAGE_CONFIG_DIR ?? homedir(), ".claudeusage");
}

export function configFile(): string {
  return resolve(configDir(), "config.json");
}

export async function readConfig(): Promise<Config | null> {
  try {
    const raw = await readFile(configFile(), "utf8");
    return configSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(configFile(), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function deleteConfig(): Promise<void> {
  await rm(configFile(), { force: true });
}
