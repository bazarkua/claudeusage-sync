import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export type RawRecord = {
  cacheCreateTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  messageId: string;
  model: string;
  outputTokens: number;
  requestId: string;
  sessionId: string;
  stopReason: string | null;
  timestamp: string;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

function nonNegativeInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function validIso(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function extract(parsed: unknown): RawRecord | null {
  if (!isObject(parsed)) {
    return null;
  }

  const message = isObject(parsed.message) ? parsed.message : {};
  const usage = isObject(message.usage)
    ? message.usage
    : isObject(parsed.usage)
      ? parsed.usage
      : null;

  if (!usage) {
    return null;
  }

  const timestamp = validIso(
    stringField(parsed.timestamp, message.timestamp, parsed.created_at),
  );
  const model = stringField(message.model, parsed.model);
  const messageId = stringField(message.id, parsed.messageId, parsed.message_id);
  const requestId =
    stringField(
      parsed.requestId,
      parsed.request_id,
      message.requestId,
      message.request_id,
    ) ?? "";
  const sessionId =
    stringField(parsed.sessionId, parsed.session_id, message.sessionId) ?? "";

  if (!timestamp || !model || !messageId) {
    return null;
  }

  return {
    cacheCreateTokens: nonNegativeInt(usage.cache_creation_input_tokens),
    cacheReadTokens: nonNegativeInt(usage.cache_read_input_tokens),
    inputTokens: nonNegativeInt(usage.input_tokens),
    messageId,
    model,
    outputTokens: nonNegativeInt(usage.output_tokens),
    requestId,
    sessionId,
    stopReason: stringField(message.stop_reason, parsed.stop_reason),
    timestamp,
  };
}

async function* streamFile(filePath: string): AsyncGenerator<RawRecord> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ crlfDelay: Infinity, input: stream });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    try {
      const record = extract(JSON.parse(line));

      if (record) {
        yield record;
      }
    } catch {
      continue;
    }
  }
}

export async function* streamAllRecords(
  rootDir: string,
): AsyncGenerator<RawRecord> {
  const projects = await readdir(rootDir).catch(() => []);

  for (const project of projects) {
    const projectPath = join(rootDir, project);
    const projectStat = await stat(projectPath).catch(() => null);

    if (!projectStat?.isDirectory()) {
      continue;
    }

    const files = await readdir(projectPath).catch(() => []);

    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }

      yield* streamFile(resolve(projectPath, file));
    }
  }
}
