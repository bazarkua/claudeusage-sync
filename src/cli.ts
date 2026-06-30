import chalk from "chalk";
import { Command } from "commander";

import { runDoctor } from "./commands/doctor.js";
import { runStatus } from "./commands/status.js";
import { runSync, type SyncOptions } from "./commands/sync.js";
import { runUnlink } from "./commands/unlink.js";
import { readPackageInfo } from "./package.js";

const packageInfo = readPackageInfo(import.meta.url);

function handleError(error: unknown): never {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

const program = new Command();

program
  .name("claudeusage-sync")
  .description("sync your Claude Code usage stats to claudeusage.com")
  .version(packageInfo.version)
  .option(
    "--token <token>",
    "use this sync token instead of the browser device flow (headless/CI)",
  )
  .option("--dry-run", "parse and build the payload but do not upload")
  .option("--since <date>", "only read records newer than this YYYY-MM-DD")
  .option(
    "--full",
    "ignore the local watermark and re-upload your entire history (use after deleting + recreating your account)",
  )
  .action((options: SyncOptions) => {
    runSync(options).catch(handleError);
  });

program
  .command("doctor")
  .description("show local Claude Code source coverage")
  .action(() => {
    runDoctor().catch(handleError);
  });

program
  .command("status")
  .description("show last sync time and masked token")
  .action(() => {
    runStatus().catch(handleError);
  });

program
  .command("unlink")
  .description("remove local config so the next sync starts fresh")
  .action(() => {
    runUnlink().catch(handleError);
  });

program
  .command("logout")
  .description("alias of unlink")
  .action(() => {
    runUnlink().catch(handleError);
  });

program.parseAsync().catch(handleError);
