# claudeusage-sync

Turn your local Claude Code usage into a public profile and leaderboard at [claudeusage.com](https://claudeusage.com) — without uploading a single prompt.

[![npm version](https://img.shields.io/npm/v/claudeusage-sync.svg)](https://www.npmjs.com/package/claudeusage-sync)
[![license: MIT](https://img.shields.io/npm/l/claudeusage-sync.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/claudeusage-sync.svg)](https://nodejs.org)

```sh
npx claudeusage-sync
```

The first run opens your browser for a one-click device approval, reads your local
Claude Code session files, asks for your consent, and uploads **aggregate numeric
stats only**. Every later run reuses the cached token and uploads just what is new.

---

## What it does

Claude Code records each session locally as JSONL files under `~/.claude/projects/`.
Those files contain your full prompts and responses, but they also contain per-message
token counts. `claudeusage-sync`:

1. Streams every `~/.claude/projects/*/*.jsonl` file line by line.
2. Extracts **only** the usage numbers from each message (token counts, model id,
   timestamp, and the ids needed to de-duplicate). Message text is never read.
3. De-duplicates records by `messageId:requestId`, keeping the highest `output_tokens`
   (Claude Code writes cumulative streaming values, so the max is the final count).
4. Groups records by your **local day** and computes WakaTime-style active hours
   (the sum of gaps shorter than 10 minutes between consecutive messages).
5. Builds an aggregate payload and `POST`s it to `https://claudeusage.com/api/ingest`.

The result powers your profile (`/u/<username>`), the global leaderboard, your activity
grid, and an API-equivalent cost estimate. You can sign in with a display name or stay
anonymous.

---

## Privacy

This is the whole point of the project, so it is worth being precise. The CLI is
MIT-licensed and source-available — you can read every line in [`src/`](./src) and
confirm the claims below for yourself.

### What is uploaded

Only aggregate, numeric usage data. The exact shape posted to `/api/ingest` is defined
in [`src/aggregate/payload.ts`](./src/aggregate/payload.ts):

```ts
type IngestPayload = {
  cliVersion: string;
  schema: 1;
  os: "darwin" | "linux" | "win32";
  machineId: string;       // one-way SHA-256 hash, see below
  windowStart: string;     // ISO timestamp of the earliest record in this sync
  windowEnd: string;       // ISO timestamp of the latest record in this sync
  sessionCount: number;    // distinct sessions in the window
  dailyBuckets: Array<{
    date: string;          // YYYY-MM-DD, your local day
    hoursActive: number;
    sessionCount: number;
    perModel: Record<string, {
      inputTokens: number;
      outputTokens: number;
      cacheCreateTokens: number;
      cacheReadTokens: number;
      messageCount: number;
      sessionCount: number;
      hoursActive: number;
      firstMessageAt: string;  // ISO timestamp
      lastMessageAt: string;   // ISO timestamp
    }>;
  }>;
};
```

That is it: token totals, message and session counts, active hours, the per-model mix,
and day-level activity. No content of any kind is in this object.

### What is never uploaded

Verifiable from [`src/parse/jsonl.ts`](./src/parse/jsonl.ts) (the only code that reads
your Claude files) and [`src/aggregate/payload.ts`](./src/aggregate/payload.ts):

- **Prompts, responses, or any message content** — the parser reads only token-count
  fields from each line and discards the rest.
- **Your code, file contents, or raw JSONL lines** — nothing from the files is forwarded.
- **File paths, project directory names, or repo names** — project folders are only used
  to locate files; their names never enter the payload.
- **Individual message, request, or session ids** — these are used locally for
  de-duplication and the incremental-sync watermark; the payload carries only *counts*.
- **Your email address or which provider you signed in with** — the CLI never reads or
  sends these. Your identity is established entirely in the browser during device approval.
- **Your raw hostname or OS username** — see `machineId` below.

### Two fields that deserve a plain explanation

- **`machineId`** is `SHA-256(hostname + ":" + osUsername)` — a one-way hash computed on
  your machine (see [`src/auth/machine.ts`](./src/auth/machine.ts)). Your real hostname and
  username never leave the device; the server only ever sees the hash, and uses it to
  group and de-duplicate syncs across the machines you sync from. During the initial
  device-auth request the CLI also sends `SHA-256(hostname)` for the same purpose.
- **Timestamps.** The payload contains coarse time bounds only: the `windowStart` /
  `windowEnd` of the sync, and the first/last message time per model per day. There is no
  per-message timestamp and no minute-by-minute activity log. Public profile pages round
  these to the day (and at most the hour for day-detail views).

Your sync token (`cu_live_...`) is your credential. It is stored locally at
`~/.claudeusage/config.json` with `0600` permissions and sent only as an
`Authorization: Bearer` header to authenticate uploads.

See the full policy at [claudeusage.com/privacy](https://claudeusage.com/privacy).

---

## Quickstart

```sh
# first run: opens your browser for a one-click device approval, then asks consent
npx claudeusage-sync

# later runs: reuses the cached token, uploads only records newer than the last sync
npx claudeusage-sync
```

On the first run the CLI prints exactly what will be uploaded and waits for a `y/N`
confirmation before sending anything. After you approve once, the consent is remembered.

Want to see what would be sent without uploading? Use `--dry-run`:

```sh
npx claudeusage-sync --dry-run
```

---

## Commands

```sh
claudeusage-sync              # (default) authenticate if needed, then sync new usage
claudeusage-sync doctor       # show local Claude Code source coverage
claudeusage-sync status       # show last sync time and masked token
claudeusage-sync unlink       # remove local config so the next sync starts fresh
claudeusage-sync logout       # alias of unlink
```

| Command  | Description |
| -------- | ----------- |
| *(none)* | Read new usage since the last sync, then upload aggregates. Authenticates first if needed. |
| `doctor` | Run the same parser as `sync` and print source coverage: JSONL files scanned, usable record count, first/last detailed-usage dates, the local sync watermark, and whether Claude's legacy `stats-cache.json` exists. |
| `status` | Print the last sync time, masked token, API base, and config path. |
| `unlink` | Delete `~/.claudeusage/config.json` so the next run re-authenticates from scratch. |
| `logout` | Alias of `unlink`. |

### Flags

These apply to the default sync command:

| Flag                  | Description |
| --------------------- | ----------- |
| `--dry-run`           | Parse and build the payload, print a summary, but do **not** upload. |
| `--since <YYYY-MM-DD>` | Only read records on or after this date (overrides the saved watermark). |
| `--token <token>`     | Use this sync token instead of the browser device flow (headless / CI). |
| `--version`           | Print the installed CLI version. |
| `--help`              | Show usage. |

### Environment variables

Mostly for CI and local testing:

| Variable                 | Effect |
| ------------------------ | ------ |
| `CLAUDEUSAGE_API`        | Override the API base URL (default `https://claudeusage.com`). |
| `CLAUDE_CONFIG_DIR`      | Override the Claude config directory; the CLI reads `<dir>/projects`. Default `~/.claude`. |
| `CLAUDEUSAGE_CONFIG_DIR` | Override where the CLI stores its own config (default `~`, i.e. `~/.claudeusage`). |
| `CLAUDEUSAGE_ASSUME_YES` | Set to `1` to skip the interactive first-run consent prompt (use in CI). |

---

## Requirements

- **Node.js 22 or newer** (Node 20 reaches end-of-life in April 2026).
- Claude Code installed and used at least once, so that `~/.claude/projects/` exists.

---

## How device authentication works

The first sign-in uses an [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)-style
OAuth device authorization flow, so the CLI never handles your password:

1. The CLI calls `POST /api/cli/auth/start` and receives a short user code plus a
   verification URL.
2. It opens that URL in your browser (and prints the code in case the browser does not
   open). You sign in with Google or GitHub and approve the device.
3. The CLI polls `POST /api/cli/auth/poll` until the request is approved, denied, or
   expires, honoring `slow_down` back-off.
4. On approval it receives a long-lived sync token (`cu_live_...`) and writes it to
   `~/.claudeusage/config.json`.

If a stored token is ever rejected (for example, you revoked it from the dashboard), the
CLI automatically re-runs the device flow and retries the upload.

---

## Headless and CI usage

Browsers are not available in CI. Create a sync token from your dashboard settings and
pass it with `--token`:

```sh
CLAUDEUSAGE_ASSUME_YES=1 npx claudeusage-sync --token="cu_live_xxxxxxxx..."
```

`CLAUDEUSAGE_ASSUME_YES=1` skips the interactive consent prompt so the run is fully
non-interactive. The token authenticates uploads exactly like a browser-approved session.

---

## Links

- Website and leaderboard: [claudeusage.com](https://claudeusage.com)
- Privacy policy: [claudeusage.com/privacy](https://claudeusage.com/privacy)
- Source and issues: [github.com/bazarkua/claudeusage-sync](https://github.com/bazarkua/claudeusage-sync)

---

## Contributing

Issues and pull requests are welcome. The project is small and dependency-light:

```sh
git clone https://github.com/bazarkua/claudeusage-sync.git
cd claudeusage-sync
npm install
npm run build        # compile TypeScript to dist/
node bin/cli.js --dry-run
```

To test against a local backend or fixture data:

```sh
CLAUDEUSAGE_API=http://localhost:3000 \
CLAUDE_CONFIG_DIR=/tmp/fake-claude \
node bin/cli.js --dry-run
```

If you find a privacy or security issue, please open an issue (or contact the maintainer
privately for sensitive reports) rather than sending a PR with details.

---

## License

[MIT](./LICENSE) © Adilbek Bazarkulov

*Not affiliated with Anthropic. "Claude" and "Claude Code" are used descriptively to
refer to the tools whose local usage this CLI reads.*
