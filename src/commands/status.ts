import chalk from "chalk";

import { configFile, readConfig } from "../auth/config.js";

function maskToken(token: string): string {
  return `${token.slice(0, 12)}...${token.slice(-4)}`;
}

export async function runStatus(): Promise<void> {
  const config = await readConfig();

  if (!config) {
    console.log(
      chalk.yellow("not authorized. run `claudeusage-sync` to link this device."),
    );
    console.log(chalk.gray(`config: ${configFile()}`));
    return;
  }

  console.log("token:          ", maskToken(config.token));
  console.log("apiBase:        ", config.apiBase);
  console.log("last synced at: ", config.lastSyncAt ?? "never");
  console.log("last message id:", config.lastSyncMessageId ?? "none");
  console.log("config:         ", configFile());
}
