import chalk from "chalk";

import { deleteConfig } from "../auth/config.js";

export async function runUnlink(): Promise<void> {
  await deleteConfig();
  console.log(chalk.gray("removed local config. run `claudeusage-sync` to re-link."));
}
