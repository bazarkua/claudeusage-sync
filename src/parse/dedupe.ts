import type { RawRecord } from "./jsonl.js";

export function recordWatermarkKey(record: RawRecord): string {
  return `${record.messageId}:${record.requestId}`;
}

export function dedupe(records: Iterable<RawRecord>): RawRecord[] {
  const best = new Map<string, RawRecord>();

  for (const record of records) {
    const key = recordWatermarkKey(record);
    const previous = best.get(key);

    if (!previous || record.outputTokens > previous.outputTokens) {
      best.set(key, record);
    }
  }

  return Array.from(best.values()).sort((a, b) => {
    const time = a.timestamp.localeCompare(b.timestamp);
    return time === 0
      ? recordWatermarkKey(a).localeCompare(recordWatermarkKey(b))
      : time;
  });
}

export function detectOutputTokenUndercount(records: RawRecord[]): boolean {
  if (records.length === 0) {
    return false;
  }

  const suspicious = records.filter(
    (record) => record.outputTokens === 1 && record.stopReason === null,
  ).length;

  return suspicious / records.length > 0.5;
}
