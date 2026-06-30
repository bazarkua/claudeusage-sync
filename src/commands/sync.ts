import chalk from "chalk";
import ora from "ora";

import { buildPayload, latestWatermark } from "../aggregate/payload.js";
import {
  type Coverage,
  getCoverage,
  IngestConflict,
  NeedsReauth,
  postIngest,
  RateLimited,
} from "../api/ingest-client.js";
import { computeMachineId } from "../auth/machine.js";
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

const DEFAULT_API = "https://www.claudeusage.com";
const packageInfo = readPackageInfo(import.meta.url);

export type SyncOptions = {
  dryRun?: boolean;
  full?: boolean;
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

// Shown once, on the first sync — transparency, not a question. Authorization
// already happened in the browser device-approval step, so there's nothing to
// answer here; the CLI just states exactly what it uploads and proceeds.
function printUploadNotice(dayCount: number, sessionCount: number) {
  console.log("");
  console.log(chalk.bold("uploading aggregate usage only:"));
  console.log(`  ${dayCount} day-buckets across ${sessionCount} sessions`);
  console.log("  numeric totals only: tokens, hours, and message counts");
  console.log(
    chalk.gray(
      "  never uploaded: prompts, responses, file paths, project names, or raw files",
    ),
  );
  console.log(chalk.gray("  privacy: https://claudeusage.com/privacy"));
  console.log("");
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
  allRecords: RawRecord[],
  version: string,
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
      upload.warn("token rejected; re-authorizing and re-uploading full history");
      await deleteConfig();
      const freshToken = await runDeviceFlow(base);
      // A rejected token means the account was reset/recreated, so it holds no
      // prior data. Send the FULL history — not just the window after the old
      // watermark, which would drop everything before the last sync. If the
      // account actually still has data (e.g. only the token was revoked), the
      // server rejects the overlap and we fall back to the incremental payload.
      const fullPayload = buildPayload(dedupe(allRecords), version);

      try {
        const result = await postIngest(base, freshToken, fullPayload);
        console.log(
          chalk.green(
            result.duplicate
              ? "already synced after re-auth; duplicate upload ignored"
              : `synced full history after re-auth (${result.newRecords} day-buckets, ${result.messageCount} messages)`,
          ),
        );
      } catch (reError) {
        if (reError instanceof IngestConflict && reError.code === "ingest_overlap") {
          const result = await postIngest(base, freshToken, payload);
          console.log(
            chalk.green(
              result.duplicate
                ? "already synced after re-auth; duplicate upload ignored"
                : `synced after re-auth (${result.newRecords} day-buckets, ${result.messageCount} messages)`,
            ),
          );
        } else {
          throw reError;
        }
      }

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
  } else if (config && !options.full) {
    // --full ignores the local watermark and re-sends the entire history. This
    // is the recovery path after deleting + recreating an account: an ordinary
    // incremental sync would only upload the window after the old watermark
    // (often just the last day) to the brand-new, empty account.
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
    // The local watermark filtered everything out — but it may be STALE (e.g. the
    // account was deleted + recreated, so the server actually has nothing). Before
    // declaring "nothing to do", reconcile against the server's real coverage so a
    // plain `claudeusage-sync` self-heals and restores the full history with no
    // flag. Skipped for headless --token runs (must never pop a browser) and the
    // explicit --since / --full paths, which already choose the window themselves.
    if (token && config && !options.full && !options.since && !options.token) {
      await reconcileEmptyPayload(base, token, config, allRecords);
      return;
    }

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
    printUploadNotice(payload.dailyBuckets.length, payload.sessionCount);
    writableConfig.consentAcceptedAt = new Date().toISOString();
  }

  await writeConfig(writableConfig);

  const finalToken = await uploadWithReauth(
    base,
    token,
    payload,
    allRecords,
    packageInfo.version,
  );
  const watermark = latestWatermark(deduped);

  await writeConfig({
    ...writableConfig,
    ...watermark,
    apiBase: base,
    token: finalToken,
  });

  console.log(chalk.bold("\nprofile:"), chalk.hex("#d97757")(`${base}/dashboard`));
}

// Reached when the local watermark says there is nothing new to upload. The
// watermark can be STALE — most importantly after the account was deleted and
// recreated, where the server now holds nothing but the old watermark still hides
// the entire history. We probe the server's real coverage and, if it is behind,
// re-upload exactly the missing window (the full history for a fresh account),
// anchored on the per-machine ingest frontier so the overlap guard never trips.
async function reconcileEmptyPayload(
  base: string,
  token: string,
  config: Config,
  allRecords: RawRecord[],
): Promise<void> {
  const machineId = computeMachineId();
  let activeToken = token;

  const probe = ora("checking the server for your synced history...").start();
  let coverage: Coverage;

  try {
    coverage = await getCoverage(base, activeToken, machineId);
    probe.stop();
  } catch (error) {
    if (error instanceof NeedsReauth) {
      // Token rejected: the account was deleted/recreated, or the token was
      // revoked. Re-authorize, then RE-PROBE with the fresh token so we upload
      // only what the (possibly brand-new) account is missing — never a blind
      // full re-upload, which would double-count an account that still has data.
      probe.warn("sync token no longer valid; re-authorizing");
      await deleteConfig();
      activeToken = await runDeviceFlow(base);
      coverage = await getCoverage(base, activeToken, machineId);
    } else if (error instanceof RateLimited) {
      probe.info("server busy; skipping the history check this run");
      await persistNoop(base, config, activeToken, allRecords);
      return;
    } else {
      // 404 (older server without this endpoint) / 5xx / network — never break a
      // routine no-op sync over a failed reconcile.
      probe.warn("could not verify server coverage; skipping the history check");
      await persistNoop(base, config, activeToken, allRecords);
      return;
    }
  }

  const frontier = coverage.machineWindowEnd;
  let resyncRecords: RawRecord[];

  if (!coverage.hasData) {
    // Empty account (the fresh-after-delete case) → send the entire history.
    resyncRecords = frontier
      ? allRecords.filter((record) => record.timestamp > frontier)
      : allRecords;
  } else if (!frontier) {
    // Account already holds data but this machine has no ingest frontier (e.g.
    // the data came from another machine). Uploading could double-count, so no-op.
    await persistNoop(base, config, activeToken, allRecords);
    return;
  } else {
    resyncRecords = allRecords.filter((record) => record.timestamp > frontier);
  }

  const resyncDeduped = dedupe(resyncRecords);
  const resyncPayload = buildPayload(resyncDeduped, packageInfo.version);

  if (resyncPayload.dailyBuckets.length === 0) {
    // Server is already caught up with this machine — a genuine no-op.
    await persistNoop(base, config, activeToken, allRecords);
    return;
  }

  console.log(
    chalk.cyan(
      `server is missing history — restoring ${resyncPayload.dailyBuckets.length} day-buckets.`,
    ),
  );

  const writableConfig: Config = { ...config, apiBase: base, token: activeToken };

  if (!writableConfig.consentAcceptedAt) {
    printUploadNotice(resyncPayload.dailyBuckets.length, resyncPayload.sessionCount);
    writableConfig.consentAcceptedAt = new Date().toISOString();
  }

  await writeConfig(writableConfig);

  const finalToken = await uploadWithReauth(
    base,
    activeToken,
    resyncPayload,
    allRecords,
    packageInfo.version,
  );
  const watermark = latestWatermark(resyncDeduped);

  await writeConfig({
    ...writableConfig,
    ...watermark,
    apiBase: base,
    token: finalToken,
  });

  console.log(chalk.bold("\nprofile:"), chalk.hex("#d97757")(`${base}/dashboard`));
}

// Genuine "nothing to do": print the message and persist config with the latest
// local record as the watermark (and any refreshed token), so the next run filters
// from the right place even if we just re-authorized.
async function persistNoop(
  base: string,
  config: Config,
  token: string,
  allRecords: RawRecord[],
): Promise<void> {
  console.log(chalk.yellow("no new Claude Code usage records to sync."));
  const watermark = latestWatermark(dedupe(allRecords));
  await writeConfig({ ...config, ...watermark, apiBase: base, token });
}
