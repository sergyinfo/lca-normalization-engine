# harvester

Node.js service that monitors the DOL website for new LCA disclosure XLSX files
and enqueues ingest tasks in BullMQ.

## Responsibility

- Polls the DOL performance data page on a configurable interval
- Parses all `.xlsx` links from the page HTML
- Compares against the `harvested_files` PostgreSQL table to detect new files
- Enqueues one `ingest` BullMQ job per new file
- Designed for **production incremental monitoring** — the historical backfill uses
  `cli-tool seed` instead

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis for BullMQ |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `DOL_BASE_URL` | `https://www.dol.gov/...` | DOL performance data page URL |
| `HARVESTER_POLL_INTERVAL_MS` | `3600000` | How often to check for new files (1h) |

## Run

```bash
pnpm --filter harvester start
```
