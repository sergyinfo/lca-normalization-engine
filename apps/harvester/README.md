# harvester

Production Node.js service that monitors the DOL website for quarterly LCA disclosure
releases, downloads discovered files to a Shared Volume, groups FLAG-era multi-file
releases by fiscal year and quarter, and builds a BullMQ Flow (parent-child task tree)
to drive the ingestion pipeline.

---

## Responsibility

| Concern | Detail |
|---|---|
| **Polling** | Checks the DOL performance data page on a weekly schedule (configurable); quarterly releases make more frequent polling wasteful |
| **HTML parsing** | Extracts all `.xlsx` links and their associated fiscal year / quarter metadata from anchor text and href patterns |
| **Change detection** | Compares discovered files against the `harvested_files` PostgreSQL table; only new or updated files proceed |
| **Download to Shared Volume** | Streams each file to `SHARED_VOLUME_PATH` before enqueuing — workers receive a local filesystem path, not a remote URL |
| **FLAG file grouping** | Groups post-2020 releases into `(FY, Q)` buckets: `LCA_Disclosure_Data`, `LCA_Worksites`, `LCA_Appendix_A` |
| **BullMQ Flow creation** | Creates one parent job per quarterly release and one child job per file within that release |
| **Metadata validation** | Validates file size, content-type, and filename pattern before writing to the volume or touching the queue |

> The harvester is exclusively for **production incremental monitoring**. Historical
> backfill is handled by `cli-tool seed`, which reads from a pre-downloaded local archive.

---

## Workflow / Lifecycle

The following sequence executes once per poll cycle. Each step is a hard gate —
failure at any step aborts that file/group without affecting others.

```
1. FETCH DOL PAGE
   GET HARVESTER_DOL_BASE_URL
   → Parse HTML → extract all .xlsx anchors

2. FILTER KNOWN FILES
   SELECT url FROM harvested_files
   → Discard any url already present in the table

3. VALIDATE METADATA
   HEAD <url>
   → Assert Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
   → Assert Content-Length > 0
   → Assert filename matches pattern:
       LCA_(Disclosure_Data|Worksites|Appendix_A)_FY\d{4}(_Q[1-4])?.xlsx

4. DOWNLOAD TO SHARED VOLUME
   GET <url> (streaming)
   → Write to SHARED_VOLUME_PATH/<filename>
   → Verify file size matches Content-Length

5. GROUP FLAG FILES  (post-FY2020 only)
   Key: (fiscal_year, quarter)
   Expected members per group:
     - LCA_Disclosure_Data_FY<YYYY>_Q<N>.xlsx  [required]
     - LCA_Worksites_FY<YYYY>_Q<N>.xlsx        [required]
     - LCA_Appendix_A_FY<YYYY>_Q<N>.xlsx       [optional — warn if absent]

6. CREATE BULLMQ FLOW
   FlowProducer.add({
     name: 'quarterly-update',           ← Parent job
     data: { fiscalYear, quarter },
     children: [
       { name: 'ingest', data: { filePath, fileType: 'disclosure' } },
       { name: 'ingest', data: { filePath, fileType: 'worksites'  } },
       { name: 'ingest', data: { filePath, fileType: 'appendix_a' } },
     ]
   })
   Parent transitions to `completed` only when ALL children succeed.

7. MARK AS HARVESTED
   INSERT INTO harvested_files (url, file_name, local_path, filing_year, quarter)
   ON CONFLICT (url) DO NOTHING
```

### BullMQ Flow Structure (per quarterly release)

```
ingest-tasks (Flow)
└── [Parent]  quarterly-update  FY2024_Q4
    ├── [Child]  ingest  LCA_Disclosure_Data_FY2024_Q4.xlsx  (type: disclosure)
    ├── [Child]  ingest  LCA_Worksites_FY2024_Q4.xlsx        (type: worksites)
    └── [Child]  ingest  LCA_Appendix_A_FY2024_Q4.xlsx       (type: appendix_a)
```

Pre-2020 flat releases produce a parent with a single child (no grouping needed).

---

## FLAG File Grouping Detail

Starting with FY2020, the DOL FLAG system publishes three related files per quarter.
The harvester identifies them by matching the filename stem against the following
patterns and extracting the `(FY, Q)` group key:

| Pattern | `fileType` token | Required |
|---|---|---|
| `LCA_Disclosure_Data_FY<YYYY>_Q<N>.xlsx` | `disclosure` | Yes |
| `LCA_Worksites_FY<YYYY>_Q<N>.xlsx` | `worksites` | Yes |
| `LCA_Appendix_A_FY<YYYY>_Q<N>.xlsx` | `appendix_a` | No — missing triggers a warning, not a failure |

A group is enqueued only after **all required files** have been successfully downloaded
to the Shared Volume. Optional files missing from a group are noted in the parent
job's `data.missingFiles` array so the ingestor can apply graceful degradation.

---

## Shared Volume

All downloaded files are written to `SHARED_VOLUME_PATH` (default: `/data/shared`).
This directory is mounted into both the `harvester` and `ingestion-worker` containers
via a Docker named volume, so workers receive a local path in job payloads rather than
a remote URL. This eliminates re-download on retry and keeps network I/O centralised
in one service.

```
/data/shared/
├── FY2024_Q4/
│   ├── LCA_Disclosure_Data_FY2024_Q4.xlsx
│   ├── LCA_Worksites_FY2024_Q4.xlsx
│   └── LCA_Appendix_A_FY2024_Q4.xlsx
└── FY2024_Q3/
    └── ...
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis / BullMQ connection |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `HARVESTER_DOL_BASE_URL` | `https://www.dol.gov/agencies/eta/foreign-labor/performance` | DOL performance data page |
| `HARVESTER_POLL_INTERVAL_MS` | `604800000` | Poll interval — default 7 days (quarterly release cadence) |
| `SHARED_VOLUME_PATH` | `/data/shared` | Filesystem path shared with ingestion workers |
| `HARVESTER_DOWNLOAD_TIMEOUT_MS` | `300000` | Per-file download timeout (5 min) |
| `LOG_LEVEL` | `info` | Pino log level |

---

## Run

```bash
# Development (auto-restart on file change)
pnpm --filter harvester dev

# Production
pnpm --filter harvester start

# Via Docker Compose (alongside full stack)
docker compose up -d harvester
```
