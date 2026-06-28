import type { RawRecord } from "./jsonl.js";

const IDLE_CUTOFF_MS = 10 * 60 * 1000;

export function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function groupByLocalDay(records: RawRecord[]): Map<string, RawRecord[]> {
  const byDay = new Map<string, RawRecord[]>();

  for (const record of records) {
    const date = new Date(record.timestamp);

    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const dateKey = toLocalDateKey(date);
    const dayRecords = byDay.get(dateKey) ?? [];
    dayRecords.push(record);
    byDay.set(dateKey, dayRecords);
  }

  for (const dayRecords of byDay.values()) {
    dayRecords.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  return byDay;
}

export function computeHoursActive(records: RawRecord[]): number {
  if (records.length < 2) {
    return 0;
  }

  const sorted = records
    .slice()
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  let totalMs = 0;

  for (let index = 1; index < sorted.length; index += 1) {
    const current = new Date(sorted[index]?.timestamp ?? "").getTime();
    const previous = new Date(sorted[index - 1]?.timestamp ?? "").getTime();
    const gap = current - previous;

    if (gap > 0 && gap < IDLE_CUTOFF_MS) {
      totalMs += gap;
    }
  }

  return Math.round((totalMs / 3_600_000) * 100) / 100;
}
