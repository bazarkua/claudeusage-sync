import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline/promises";

import { buildPayload, latestWatermark } from "../aggregate/payload.js";
import {
  IngestConflict,
  NeedsReauth,
  postIngest,
  RateLimited,
} from "../api/ingest-client.js";
import {
  deleteConfig,
  readConfig,
  writeConfig,
  type Config,
} from "../auth/config.js";
import { runDeviceFlow } from "../auth/device-flow.js";
import { readPackageInfo } from "../package.js";
import {
  dedupe,
  detectOutputTokenUndercount,
  recordWatermarkKey,
} from "../parse/dedupe.js";
import type { RawRecord } from "../parse/jsonl.js";
import { streamAllRecords } from "../parse/jsonl.js";
import { resolveClaudeDir } from "../parse/paths.js";

const DEFAULT_API = "https://claudeusage.com";
const packageInfo = readPackageInfo(import.meta.url);

export type SyncOptions = {
  dryRun?: boolean;
  since?: string;
  token?: string;
};

function apiBase(): string {
  return (process.env.CLAUDEUSAGE_API ?? DEFAULT_API).replace(/\/$/, "");
}

function parseSince(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`bad --since value: ${value}`);
  }

  const ms = Date.parse(`${value}T00:00:00`);

  if (!Number.isFinite(ms)) {
    throw new Error(`bad --since value: ${value}`);
  }

  return ms;
}

function afterWatermark(record: RawRecord, config: Config): boolean {
  if (!config.lastSyncAt) {
    return true;
  }

  if (record.timestamp > config.lastSyncAt) {
    return true;
  }

  return (
    record.timestamp === config.lastSyncAt &&
    Boolean(config.lastSyncMessageId) &&
    recordWatermarkKey(record) > config.lastSyncMessageId!
  );
}

async function readRecords(): Promise<RawRecord[]> {
  const rootDir = resolveClaudeDir();
  const records: RawRecord[] = [];

  for await (const record of streamAllRecords(rootDir)) {
    records.push(record);
  }

  return records;
}

async function confirmConsent(dayCount: number, sessionCount: number) {
  if (process.env.CLAUDEUSAGE_ASSUME_YES === "1") {
    return true;
  }

  console.log("");
  console.log(chalk.bold("first-time sync - what will be uploaded:"));
  console.log(`  ${dayCount} day-buckets across ${sessionCount} sessions`);
  console.log("  numeric totals only: tokens, hours, and message counts");
  console.log(
    `  ${chalk.gray(
      "no prompts, responses, file paths, project names, or raw JSONL files are uploaded",
    )}`,
  );
  console.log(`  ${chalk.gray("privacy: https://claudeusage.com/privacy")}`);
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(chalk.bold("send aggregates? [y/N] ")))
    .trim()
    .toLowerCase();
  rl.close();

  return answer === "y" || answer === "yes";
}

function printDryRun(payload: ReturnType<typeof buildPayload>, records: number) {
  const totals = payload.dailyBuckets.reduce(
    (acc, bucket) => {
      for (const model of Object.values(bucket.perModel)) {
        acc.input += model.inputTokens;
        acc.output += model.outputTokens;
        acc.cacheCreate += model.cacheCreateTokens;
        acc.cacheRead += model.cacheReadTokens;
        acc.messages += model.messageCount;
      }
      return acc;
    },
    { cacheCreate: 0, cacheRead: 0, input: 0, messages: 0, output: 0 },
  );

  console.log(chalk.bold("\ndry run - payload summary:"));
  console.log("  records:     ", records);
  console.log("  windowStart: ", payload.windowStart);
  console.log("  windowEnd:   ", payload.windowEnd);
  console.log("  sessions:    ", payload.sessionCount);
  console.log("  dailyBuckets:", payload.dailyBuckets.length);
  console.log("  messages:    ", totals.messages);
  console.log("  inputTokens: ", totals.input);
  console.log("  outputTokens:", totals.output);
  console.log("  cacheCreate: ", totals.cacheCreate);
  console.log("  cacheRead:   ", totals.cacheRead);
}

async function uploadWithReauth(
  base: string,
  token: string,
  payload: ReturnType<typeof buildPayload>,
): Promise<string> {
  const upload = ora(`uploading ${payload.dailyBuckets.length} day-buckets...`).start();

  try {
    const result = await postIngest(base, token, payload);
    upload.succeed(
      result.duplicate
        ? "already synced; duplicate upload ignored"
        : `synced ${result.newRecords} day-buckets (${result.messageCount} messages)`,
    );
    return token;
  } catch (error) {
    if (error instanceof NeedsReauth) {
      upload.warn("token rejected; re-running device authorization");
      await deleteConfig();
      const freshToken = await runDeviceFlow(base);
      const result = await postIngest(base, freshToken, payload);
      console.log(
        chalk.green(
          result.duplicate
            ? "already synced after re-auth; duplicate upload ignored"
            : `synced after re-auth (${result.newRecords} day-buckets, ${result.messageCount} messages)`,
        ),
      );
      return freshToken;
    }

    if (error instanceof RateLimited) {
      upload.fail(`rate-limited. retry in ${error.retryAfterSec}s.`);
      throw error;
    }

    if (error instanceof IngestConflict) {
      if (error.code === "ingest_overlap") {
        upload.fail(
          "upload overlaps data already accepted for this machine; refusing to double-count",
        );
        throw new Error(
          "overlapping sync rejected. Run `claudeusage-sync` normally, or contact support if you need a history reset/backfill.",
        );
      }

      if (error.code === "ingest_in_progress") {
        upload.fail(
          `another upload is still being applied. retry in ${error.retryAfterSec ?? 30}s.`,
        );
        throw error;
      }
    }

    upload.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function runSync(options: SyncOptions): Promise<void> {
  const base = apiBase();
  const existingConfig = await readConfig();
  let token = options.token ?? existingConfig?.token;
  const config: Config | null = existingConfig
    ? { ...existingConfig, apiBase: base }
    : token
      ? { apiBase: base, token }
      : null;

  const spinner = ora("reading Claude Code session files...").start();
  const allRecords = await readRecords();
  spinner.succeed(`read ${allRecords.length} records from ${resolveClaudeDir()}`);

  let filtered = allRecords;

  if (options.since) {
    const cutoff = parseSince(options.since);
    filtered = allRecords.filter(
      (record) => new Date(record.timestamp).getTime() >= cutoff,
    );
  } else if (config) {
    filtered = allRecords.filter((record) => afterWatermark(record, config));
  }

  const deduped = dedupe(filtered);

  if (detectOutputTokenUndercount(deduped)) {
    console.log(
      chalk.yellow(
        "warning: output token undercount suspected in this data; output totals may be low.",
      ),
    );
  }

  console.log(chalk.gray(`  ${deduped.length} records after dedupe`));

  const payload = buildPayload(deduped, packageInfo.version);

  if (options.dryRun) {
    printDryRun(payload, deduped.length);
    return;
  }

  if (payload.dailyBuckets.length === 0) {
    console.log(chalk.yellow("no new Claude Code usage records to sync."));
    if (config) {
      await writeConfig(config);
    }
    return;
  }

  if (!token) {
    token = await runDeviceFlow(base);
  }

  const writableConfig: Config = config ?? { apiBase: base, token };
  writableConfig.apiBase = base;
  writableConfig.token = token;

  if (!writableConfig.consentAcceptedAt) {
    const ok = await confirmConsent(payload.dailyBuckets.length, payload.sessionCount);

    if (!ok) {
      console.log(chalk.yellow("aborted by user."));
      return;
    }

    writableConfig.consentAcceptedAt = new Date().toISOString();
  }

  await writeConfig(writableConfig);

  const finalToken = await uploadWithReauth(base, token, payload);
  const watermark = latestWatermark(deduped);

  await writeConfig({
    ...writableConfig,
    ...watermark,
    apiBase: base,
    token: finalToken,
  });

  console.log(chalk.bold("\nprofile:"), chalk.hex("#d97757")(`${base}/dashboard`));
}
