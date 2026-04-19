# ingestor

BullMQ worker that streams XLSX files into PostgreSQL via `pg-copy-streams`.

## Responsibility

Consumes `ingest-tasks` queue jobs. Each job specifies an XLSX file path (or URL).
The worker streams rows using `xlstream`, batches them, and bulk-inserts via
`COPY FROM STDIN` into the `lca_records` JSONB-partitioned table.

After each batch is written, it enqueues an `nlp:classify` job so the NLP worker
can asynchronously enrich the records with SOC codes.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis for BullMQ |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `INGESTOR_CONCURRENCY` | `4` | Parallel XLSX files processed simultaneously |
| `INGESTOR_BATCH_SIZE` | `5000` | Rows per `COPY` call |

## Run

```bash
pnpm --filter ingestor start
# or via Docker Compose:
docker compose up ingestion-worker
```
