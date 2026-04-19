# ingestor

High-throughput BullMQ worker that streams XLSX disclosure files into PostgreSQL using
SAX-based row iteration, on-the-fly TSV transformation, and `COPY FROM STDIN` — with a
hard memory ceiling of **≤ 250 MB RSS** regardless of source file size.

---

## Responsibility

| Concern | Detail |
|---|---|
| **Job consumption** | Consumes `ingest-tasks` child jobs produced by the harvester's BullMQ Flow |
| **File access** | Reads XLSX files from `SHARED_VOLUME_PATH` — files are pre-downloaded by the harvester; the worker never issues outbound HTTP requests |
| **SAX streaming** | Parses XLSX row-by-row via `xlstream` (SAX, not DOM) — the entire workbook is never loaded into the V8 heap |
| **Zod validation** | Each row is validated against a versioned Zod schema before entering the write path |
| **TSV transform** | Valid rows pass through a Node.js `Transform` stream that serialises JSON objects to TSV on-the-fly, the only format accepted by `pg-copy-streams` at full throughput |
| **Staging insert** | TSV stream is piped via `COPY FROM STDIN` into `staging.raw_lca_data` — not directly into `lca_records` |
| **Quarantine routing** | Invalid rows are redirected to `staging.quarantine_records` (or the BullMQ DLQ) without interrupting the stream |
| **Flow continuation** | After each batch, triggers the next BullMQ Flow phase: SOC classification (NLP worker) **and** Entity Resolution (employer deduplication) |

> **Production note:** the ingestor never fetches files from the internet. All paths in
> job payloads are absolute filesystem paths within `SHARED_VOLUME_PATH`, which is
> mounted as a Docker named volume shared with the harvester container.

---

## Processing Pipeline

```
XLSX file (SHARED_VOLUME_PATH)
        │
        ▼
  xlstream (SAX parser)
  ── emits one row object at a time ──────────────────────────────┐
        │                                                         │
        ▼                                                         │
  Zod validation (per row)                                        │
        │                                                         │
   ┌────┴──────┐                                                  │
   │           │                                                  │
valid       invalid                                               │
   │           │                                                  │
   │           ▼                                                  │
   │    staging.quarantine_records  ←─ INSERT with error list     │
   │    (or BullMQ DLQ)                                           │
   │                                                              │
   ▼                                                   (batch N+1 repeats)
Transform stream
(JSON → TSV serialisation, on-the-fly)
        │
        ▼
pg-copy-streams  ──  COPY FROM STDIN
        │
        ▼
staging.raw_lca_data   (partitioned by filing_year, JSONB)
        │
        ▼
BullMQ Flow — next phase
  ├── nlp:classify   → NLP worker  (SOC code prediction, BERT)
  └── er:deduplicate → NLP worker  (employer Entity Resolution, 3-layer)
```

---

## Memory Constraint Guarantee

The worker is architecturally bounded to **≤ 250 MB RSS** even when processing
source files exceeding 5 GB:

- **`xlstream` (SAX)** — emits one row at a time via an async iterator. The
  remainder of the workbook stays on the OS filesystem buffer cache; nothing is
  pre-loaded into the V8 heap.
- **Node.js `pipeline()`** — connects the SAX iterator → Transform → `pg-copy-streams`
  in a single backpressure-managed chain. If the PostgreSQL socket buffer fills,
  backpressure propagates upstream and pauses the SAX reader automatically — the
  batch array never accumulates unboundedly.
- **Transform stream** — serialises rows to TSV incrementally. Each row is
  written as `\n`-terminated bytes and flushed; the prior row is immediately
  eligible for garbage collection.
- **Batch ceiling** — the `pipeline()` is torn down and rebuilt every
  `INGESTOR_BATCH_SIZE` rows (default: 5,000). The array holding the current
  batch is explicitly dereferenced after each `COPY` call.

This design eliminates the class of `FATAL ERROR: Reached heap limit` crashes that
occur when naively loading entire XLSX workbooks or building large in-memory INSERT
value arrays.

---

## Staging Table: `staging.raw_lca_data`

The ingestor writes into a staging table, not directly into `lca_records`. This
separates raw ingestion throughput from the normalisation concerns (SOC enrichment,
deduplication) handled downstream by the NLP worker.

```sql
CREATE TABLE staging.raw_lca_data (
  id          BIGSERIAL,
  filing_year SMALLINT   NOT NULL,
  source_file TEXT,
  data        JSONB      NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, filing_year)
) PARTITION BY RANGE (filing_year);
```

The NLP worker reads from `staging.raw_lca_data`, enriches each record with
`soc_code` and `canonical_employer_id`, and then moves the completed row into
the production `lca_records` table.

### TSV Transform

`pg-copy-streams` operates on raw bytes. The Transform stream converts each
validated JSON row object into a single TSV line:

```
<filing_year>\t<source_file>\t<json_string>\n
```

This avoids JSON stringification inside the SQL layer and lets PostgreSQL cast
the final column directly to JSONB at the wire level, which is measurably faster
than parameterised `INSERT` statements at high row counts.

---

## Validation & Error Handling

### Zod Schema

Each row is validated against a versioned Zod schema before entering the TSV
transform. The schema enforces:

- Required fields: `CASE_NUMBER`, `CASE_STATUS`, `EMPLOYER_NAME`, `SOC_CODE`,
  `WAGE_RATE_OF_PAY_FROM`, `WAGE_UNIT_OF_PAY`, `BEGIN_DATE`, `END_DATE`
- FEIN format: `^\d{2}-\d{7}$`
- Date fields: coerced to ISO-8601
- Wage fields: numeric, non-negative

### Quarantine Strategy

Invalid rows do **not** crash or stall the stream. They are routed based on
`QUARANTINE_STRATEGY`:

| Strategy | Behaviour |
|---|---|
| `db` (default) | Row inserted into `staging.quarantine_records` with full Zod error list serialised as JSONB |
| `dlq` | Row moved to the BullMQ Dead Letter Queue (`ingest-tasks:failed`) for operator inspection |
| `both` | Row written to both destinations |

The stream continues processing the next row immediately after routing a failure.
At the end of the batch, the ingestor logs a `quarantine_summary` structured log
entry with counts of valid vs. invalid rows for observability.

### Idempotent Reprocessing

Quarantined records can be re-submitted after fixing the upstream data quality
issue via `lca-cli reprocess:quarantine`. Re-insertions use
`INSERT ... ON CONFLICT (id, filing_year) DO UPDATE` to prevent duplicate rows.

---

## BullMQ Flow Continuation

After each successful `COPY` batch, the ingestor adds two child jobs to the
active BullMQ Flow rather than one:

```js
await flowProducer.add({
  name: 'enrichment-phase',
  data: { batchId, filingYear, rowCount },
  children: [
    { name: 'nlp:classify',   data: { batchId }, queue: 'nlp-tasks' },
    { name: 'er:deduplicate', data: { batchId }, queue: 'nlp-tasks' },
  ],
});
```

Both children are independent — they run in parallel on the NLP worker. The
parent `enrichment-phase` job completes only when both succeed, giving the
BullMQ dashboard a clean per-batch enrichment status.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis / BullMQ connection |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `SHARED_VOLUME_PATH` | `/data/shared` | Mount path for harvester-downloaded XLSX files |
| `INGESTOR_CONCURRENCY` | `4` | Parallel XLSX files processed simultaneously |
| `INGESTOR_BATCH_SIZE` | `5000` | Rows per `COPY FROM STDIN` call |
| `QUARANTINE_STRATEGY` | `db` | Where to route invalid rows: `db`, `dlq`, or `both` |
| `LOG_LEVEL` | `info` | Pino log level |

---

## Run

```bash
# Development (auto-restart on file change)
pnpm --filter ingestor dev

# Production
pnpm --filter ingestor start

# Via Docker Compose
docker compose up ingestion-worker
```
