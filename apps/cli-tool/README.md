# cli-tool (lca-cli)

CLI script for database initialisation and seeding the BullMQ task tree from a
local directory of historical LCA XLSX files.

## Commands

| Command | Description |
|---|---|
| `lca-cli db:init` | Create PostgreSQL schema (idempotent — safe to run multiple times) |
| `lca-cli seed --files-dir <path>` | Walk a local archive and enqueue one BullMQ job per XLSX file |
| `lca-cli queue:stats` | Print waiting / active / completed / failed job counts |
| `lca-cli queue:drain` | **Destructive** — remove all waiting jobs from the queue |

## Historical Backfill Workflow

```bash
# 1. Initialise schema
pnpm --filter cli-tool run db:init

# 2. Dry-run to verify file discovery
node apps/cli-tool/index.js seed --files-dir /data/lca-archive --dry-run

# 3. Seed the queue (workers must already be running)
node apps/cli-tool/index.js seed --files-dir /data/lca-archive

# 4. Monitor progress
node apps/cli-tool/index.js queue:stats
```

The `seed` command groups files by the 4-digit year found in the filename and
bulk-adds them to the `ingest-tasks` BullMQ queue with exponential-backoff retries.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis for BullMQ |
| `DATABASE_URL` | — | PostgreSQL connection string |
