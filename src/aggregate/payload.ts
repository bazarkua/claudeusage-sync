import { computeMachineId, detectOs } from "../auth/machine.js";
import { recordWatermarkKey } from "../parse/dedupe.js";
import { computeHoursActive, groupByLocalDay } from "../parse/hours.js";
import type { RawRecord } from "../parse/jsonl.js";

export type IngestPayload = {
  cliVersion: string;
  dailyBuckets: Array<{
    date: string;
    hoursActive: number;
    perModel: Record<
      string,
      {
        cacheCreateTokens: number;
        cacheReadTokens: number;
        firstMessageAt: string;
        hoursActive: number;
        inputTokens: number;
        lastMessageAt: string;
        messageCount: number;
        outputTokens: number;
        sessionCount: number;
      }
    >;
    sessionCount: number;
  }>;
  machineId: string;
  os: "darwin" | "linux" | "win32";
  schema: 1;
  sessionCount: number;
  windowEnd: string;
  windowStart: string;
};

type MutableModelBucket =
  IngestPayload["dailyBuckets"][number]["perModel"][string] & {
    records: RawRecord[];
    sessions: Set<string>;
  };

function emptyPayload(cliVersion: string): IngestPayload {
  const now = new Date().toISOString();

  return {
    cliVersion,
    dailyBuckets: [],
    machineId: computeMachineId(),
    os: detectOs(),
    schema: 1,
    sessionCount: 0,
    windowEnd: now,
    windowStart: now,
  };
}

export function buildPayload(
  records: RawRecord[],
  cliVersion: string,
): IngestPayload {
  if (records.length === 0) {
    return emptyPayload(cliVersion);
  }

  const byDay = groupByLocalDay(records);
  const sessions = new Set<string>();
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;

  const dailyBuckets = Array.from(byDay.entries())
    .map(([date, dayRecords]) => {
      const perModel: Record<string, MutableModelBucket> = {};
      const daySessions = new Set<string>();

      for (const record of dayRecords) {
        const timestampMs = new Date(record.timestamp).getTime();
        minTimestamp = Math.min(minTimestamp, timestampMs);
        maxTimestamp = Math.max(maxTimestamp, timestampMs);

        if (record.sessionId) {
          sessions.add(record.sessionId);
          daySessions.add(record.sessionId);
        }

        const model = perModel[record.model] ?? {
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          firstMessageAt: record.timestamp,
          hoursActive: 0,
          inputTokens: 0,
          lastMessageAt: record.timestamp,
          messageCount: 0,
          outputTokens: 0,
          records: [],
          sessionCount: 0,
          sessions: new Set<string>(),
        };

        model.cacheCreateTokens += record.cacheCreateTokens;
        model.cacheReadTokens += record.cacheReadTokens;
        model.inputTokens += record.inputTokens;
        model.outputTokens += record.outputTokens;
        model.messageCount += 1;
        model.records.push(record);

        if (record.sessionId) {
          model.sessions.add(record.sessionId);
        }

        if (record.timestamp < model.firstMessageAt) {
          model.firstMessageAt = record.timestamp;
        }

        if (record.timestamp > model.lastMessageAt) {
          model.lastMessageAt = record.timestamp;
        }

        perModel[record.model] = model;
      }

      const finalPerModel: IngestPayload["dailyBuckets"][number]["perModel"] =
        {};

      for (const [modelId, model] of Object.entries(perModel)) {
        finalPerModel[modelId] = {
          cacheCreateTokens: model.cacheCreateTokens,
          cacheReadTokens: model.cacheReadTokens,
          firstMessageAt: model.firstMessageAt,
          hoursActive: computeHoursActive(model.records),
          inputTokens: model.inputTokens,
          lastMessageAt: model.lastMessageAt,
          messageCount: model.messageCount,
          outputTokens: model.outputTokens,
          sessionCount: model.sessions.size,
        };
      }

      return {
        date,
        hoursActive: computeHoursActive(dayRecords),
        perModel: finalPerModel,
        sessionCount: daySessions.size,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    cliVersion,
    dailyBuckets,
    machineId: computeMachineId(),
    os: detectOs(),
    schema: 1,
    sessionCount: sessions.size,
    windowEnd: new Date(maxTimestamp).toISOString(),
    windowStart: new Date(minTimestamp).toISOString(),
  };
}

export function latestWatermark(
  records: RawRecord[],
): { lastSyncAt?: string; lastSyncMessageId?: string } {
  let latest: RawRecord | null = null;

  for (const record of records) {
    if (!latest) {
      latest = record;
      continue;
    }

    if (record.timestamp > latest.timestamp) {
      latest = record;
      continue;
    }

    if (
      record.timestamp === latest.timestamp &&
      recordWatermarkKey(record) > recordWatermarkKey(latest)
    ) {
      latest = record;
    }
  }

  return latest
    ? {
        lastSyncAt: latest.timestamp,
        lastSyncMessageId: recordWatermarkKey(latest),
      }
    : {};
}
