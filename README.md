# claudeusage-sync

Public CLI for syncing local Claude Code usage aggregates to [claudeusage.com](https://claudeusage.com).

```sh
npx claudeusage-sync
```

The first run opens your browser, asks you to approve the device, scans local Claude Code JSONL session files, asks for consent, and uploads aggregate usage stats.

## What Gets Uploaded

Only aggregate numeric usage data:

- daily token totals per model
- message and session counts
- WakaTime-style active hours
- machine id
- CLI version and OS

Prompts, responses, project names, file paths, and raw Claude Code JSONL files are not uploaded.

## Commands

```sh
claudeusage-sync              # authenticate if needed, then sync
claudeusage-sync --dry-run    # parse and summarize without uploading
claudeusage-sync --since=2026-06-01
claudeusage-sync --token=cu_live_...
claudeusage-sync doctor
claudeusage-sync status
claudeusage-sync unlink
claudeusage-sync logout
```

`doctor` uses the same local parser as sync and prints source coverage:
JSONL file count, uploadable record count, first/last detailed usage dates,
local sync watermark, and whether Claude's legacy aggregate stats cache exists.

## Local Testing

Point the CLI at a local web app:

```sh
CLAUDEUSAGE_API=http://localhost:3000 node bin/cli.js
```

Override the Claude config directory for fixture tests:

```sh
CLAUDE_CONFIG_DIR=/tmp/fake-claude node bin/cli.js --dry-run
```

## Requirements

Node.js 22 or newer.

## License

MIT.
