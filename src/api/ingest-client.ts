import { z } from "zod";

import type { IngestPayload } from "../aggregate/payload.js";

const ingestResponseSchema = z.object({
  accepted: z.boolean(),
  batchId: z.string().optional(),
  buckets: z.number().optional(),
  duplicate: z.boolean().optional(),
  messageCount: z.number(),
  newRecords: z.number(),
  updatedAt: z.string(),
  userId: z.string(),
});

export type IngestResult = z.infer<typeof ingestResponseSchema>;

export class NeedsReauth extends Error {
  constructor() {
    super("needs_reauth");
    this.name = "NeedsReauth";
  }
}

export class RateLimited extends Error {
  constructor(public readonly retryAfterSec: number) {
    super(`rate_limited:${retryAfterSec}s`);
    this.name = "RateLimited";
  }
}

export class IngestConflict extends Error {
  constructor(
    public readonly code: string,
    public readonly retryAfterSec?: number,
  ) {
    super(code);
    this.name = "IngestConflict";
  }
}

export async function postIngest(
  apiBase: string,
  token: string,
  payload: IngestPayload,
): Promise<IngestResult> {
  const response = await fetch(`${apiBase}/api/ingest`, {
    body: JSON.stringify(payload),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (response.status === 401) {
    throw new NeedsReauth();
  }

  if (response.status === 429) {
    const retryAfterSec = Number(response.headers.get("retry-after") ?? "60");
    throw new RateLimited(Number.isFinite(retryAfterSec) ? retryAfterSec : 60);
  }

  if (response.status === 409) {
    const retryAfterSec = Number(response.headers.get("retry-after") ?? "");
    const body = await response.json().catch(() => null);
    const code =
      body && typeof body.error === "string" ? body.error : "ingest_conflict";
    throw new IngestConflict(
      code,
      Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
    );
  }

  if (!response.ok) {
    throw new Error(
      `ingest failed: ${response.status} ${await response.text().catch(() => "")}`,
    );
  }

  return ingestResponseSchema.parse(await response.json());
}
