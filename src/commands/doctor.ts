import chalk from "chalk";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { readConfig } from "../auth/config.js";
import { dedupe } from "../parse/dedupe.js";
import type { RawRecord } from "../parse/jsonl.js";
import { streamAllRecords } from "../parse/jsonl.js";
import { resolveClaudeDir } from "../parse/paths.js";

type LegacyStatsCache = {
  firstSessionDate?: unknown;
  lastComputedDate?: unknown;
  totalMessages?: unknown;
  totalSessions?: unknown;
};

function formatIso(value: string | undefined): string {
  if (!value) {
    return "none";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toLocaleString()} (${date.toISOString()})`;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function countDirectJsonlFiles(rootDir: string): Promise<number> {
  const projects = await readdir(rootDir).catch(() => []);
  let count = 0;

  for (const project of projects) {
    const projectPath = join(rootDir, project);
    const projectStat = await stat(projectPath).catch(() => null);

    if (!projectStat?.isDirectory()) {
      continue;
    }

    const files = await readdir(projectPath).catch(() => []);
    count += files.filter((file) => file.endsWith(".jsonl")).length;
  }

  return count;
}

async function readRecords(rootDir: string): Promise<RawRecord[]> {
  const records: RawRecord[] = [];

  for await (const record of streamAllRecords(rootDir)) {
    records.push(record);
  }

  return records;
}

async function readLegacyStatsCache(rootDir: string): Promise<LegacyStatsCache | null> {
  const statsPath = resolve(dirname(rootDir), "stats-cache.json");
  const raw = await readFile(statsPath, "utf8").catch(() => null);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as LegacyStatsCache)
      : null;
  } catch {
    return null;
  }
}

export async function runDoctor(): Promise<void> {
  const rootDir = resolveClaudeDir();
  const [fileCount, records, config, legacy] = await Promise.all([
    countDirectJsonlFiles(rootDir),
    readRecords(rootDir),
    readConfig(),
    readLegacyStatsCache(rootDir),
  ]);
  const deduped = dedupe(records);
  const firstRecord = deduped.at(0);
  const lastRecord = deduped.at(-1);

  console.log(chalk.bold("claudeusage source doctor"));
  console.log("");
  console.log("Claude projects path:", chalk.gray(rootDir));
  console.log("JSONL files scanned: ", fileCount);
  console.log("usage records:       ", records.length);
  console.log("after dedupe:        ", deduped.length);
  console.log("first detailed usage:", formatIso(firstRecord?.timestamp));
  console.log("last detailed usage: ", formatIso(lastRecord?.timestamp));
  console.log("");

  if (config) {
    console.log(chalk.bold("local sync config"));
    console.log("api base:            ", config.apiBase);
    console.log("last synced at:      ", config.lastSyncAt ?? "never");
    console.log("last message id:     ", config.lastSyncMessageId ?? "none");
  } else {
    console.log(chalk.bold("local sync config"));
    console.log(chalk.yellow("not linked yet"));
  }

  console.log("");
  console.log(chalk.bold("legacy stats cache"));

  if (!legacy) {
    console.log("not found");
    return;
  }

  const firstSessionDate = stringField(legacy.firstSessionDate);
  const lastComputedDate = stringField(legacy.lastComputedDate);
  const totalMessages = numberField(legacy.totalMessages);
  const totalSessions = numberField(legacy.totalSessions);

  console.log("first session:       ", formatIso(firstSessionDate ?? undefined));
  console.log("last computed:       ", lastComputedDate ?? "unknown");
  console.log("messages:            ", totalMessages ?? "unknown");
  console.log("sessions:            ", totalSessions ?? "unknown");

  if (
    firstSessionDate &&
    firstRecord?.timestamp &&
    firstSessionDate < firstRecord.timestamp
  ) {
    console.log("");
    console.log(
      chalk.yellow(
        "legacy cache starts earlier than detailed JSONL; sync keeps it separate because it is aggregate/incomplete.",
      ),
    );
  }
}
