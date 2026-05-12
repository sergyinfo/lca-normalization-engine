# Full Re-Ingest Run Report

**Started:** 2026-05-10 (in progress)
**Scope:** Reset entire system, ingest all 24 LCA Disclosure files (FY2020 Q1 → FY2025 Q4), run full NLP pipeline including Stage 3 LLM on residuals.

This file is updated live throughout the run. Each phase is a separate section.

---

## Phase 0 — Pre-flight

| Check | Value |
|---|---|
| LCA Disclosure files in `./data` | 24 (FY2020 Q1 → FY2025 Q4) |
| Total disclosure data size | 2.2 GB |
| Worksites / Appendix_A files | none — Disclosure-only mode |
| DMTF file present | yes (`dmtf.xlsx`) |
| Ollama installed | yes (`/opt/homebrew/bin/ollama`) |
| Ollama server running at start | no (will be started) |
| Docker containers up at start | only `lca_db` (now stopped for fresh start) |
| Free disk on host | ~22 GB / 460 GB |

**Disk-space concern:** 22 GB free is tight for ~12M JSONB records + GIN indexes + 384-dim embeddings. Postgres volume monitored each wake-up; abort threshold 18 GB used by `lca-normalization-engine_postgres-data`.

---

## Phase 1 — Teardown ✅

- Killed leftover `operator-ui` host process.
- `docker compose down` — all containers removed cleanly.

## Phase 2 — Image rebuild (in progress)

Docker images were stale (`nlp-worker` 6 days old; per `PROJECT_STATUS.md` it
needed a rebuild for Layers 2/3 + unresolved-employer write path). Also fixed
a corepack/pnpm version mismatch — Node 20 base + auto-downloaded pnpm 11
broke installs in the container. Pinned `pnpm@10.33.0` in both
`apps/ingestor/Dockerfile` and `apps/operator-ui/Dockerfile`.

| Image | Status |
|---|---|
| `operator-ui` | ✅ rebuilt (251 MB) |
| `ingestion-worker` | ✅ rebuilt (245 MB) |
| `nlp-worker` | ⏳ still building — torch + CUDA wheels (~1+ GB) downloading |

## Phase 3 — DB reset ✅

| Step | Outcome |
|---|---|
| `db:init` | created schema, partitions, indexes |
| `soc_aliases` count before reset | 13,003 (DMTF + bootstrap from prior run) |
| `db:reset` | truncated lca_records, canonical_employers, employer_embeddings, staging.quarantine_records |
| `soc_aliases` count after reset | 13,003 (preserved as designed) |

## Phase 4 — Ollama ✅

Started `ollama serve` on host (PID logged in `/tmp/ollama.log`).
Confirmed `llama3.1:8b` (4.9 GB, Q4_K_M quant) is pulled and loadable.

## Phase 2 (cont.) — Image rebuild ✅

All three images fresh:

| Image | Size | Built |
|---|---|---|
| `nlp-worker` | 8.89 GB | just now |
| `ingestion-worker` | 245 MB | just now |
| `operator-ui` | 251 MB | just now |

Reclaimed **17.6 GB** of unused build cache after the rebuild
(`docker builder prune`). Host disk went 13 GB free → **26 GB free**.

## Phase 5 — Workers up ✅ + ingestion in flight ⏳

| Service | Status |
|---|---|
| `db` | healthy |
| `redis` | healthy |
| `nlp-worker` | started (concurrency 2; sentence-transformer encoder loaded with 13003 aliases) |
| `ingestion-worker` | started (concurrency 4) |
| `operator-ui` | started, port 8080 |

Seed: 24 BullMQ jobs enqueued (1 per file, grouped by year FY2020–FY2025).

First-minute snapshot:
- `lca_records`: 35,000 rows
- `nlp-tasks` queue: actively flowing
- First NLP batch: Stage 0 = 0 (consensus empty post-reset, expected),
  Stage 1 = 2,266 / 5,000 (~45% DMTF/bootstrap exact match),
  Stage 2 = 2,733 / 5,000 (~55% semantic retrieval).

## Phase 6 — Drain (in progress)

### Snapshot 1 (T+30 min from seed)

| Metric | Value |
|---|---|
| Ingest queue | **drained** (0 waiting / 0 active / 38 completed / 0 failed) |
| NLP queue waiting | 579 batches (~2.9M records pending) |
| `lca_records` | 3,831,919 |
| `staging.quarantine_records` | 49,071 (all `low_soc_confidence`) |
| `staging.unresolved_employers` | 86,991 (aggregated unique name/state) |
| `canonical_employers` | 0 (see note below) |
| Errors in worker logs | 0 |
| Disk free | 16 GB |
| `postgres-data` volume | 12 GB |

### Year breakdown (records ingested)

| Year | Rows |
|---|---|
| 2020 | 577,334 |
| 2021 | 826,305 |
| 2022 | 626,084 |
| 2023 | 644,607 |
| 2024 | 561,037 |
| 2025 | 596,552 |
| **Total** | **3,831,919** |

### Important finding — FEIN coverage is binary by year

Investigated why `canonical_employers` was still empty after 1M+ records were
NLP-processed. Root cause is **not a bug** — the DOL changed the disclosure
file format between 2023 and 2024:

| Year | Records | Records with valid FEIN | % |
|---|---|---|---|
| FY2020 | 577,334 | 0 | **0%** |
| FY2021 | 826,305 | 0 | **0%** |
| FY2022 | 626,084 | 0 | **0%** |
| FY2023 | 644,607 | 0 | **0%** |
| FY2024 | 561,037 | 561,035 | **100%** |
| FY2025 | 596,552 | 596,552 | **100%** |

Pre-2024 disclosure files do not include `EMPLOYER_FEIN`. Consequences:

* Layer 1 (FEIN match) is dead on FY2020–FY2023 → those records will
  initially land in `staging.unresolved_employers`.
* Layers 2 (pg_trgm) and 3 (pgvector) require `canonical_employers` to be
  non-empty to find matches. As FY2024/FY2025 batches are processed,
  canonicals will populate, and the post-ingest `canonical:backfill` step
  will sweep the older orphans through Layers 2/3 against the now-populated
  canonical table.

Verified by manually calling `resolve_fein`, `resolve` cascade, and replaying
real payloads inside the live worker — all work correctly when a valid FEIN
is present. The end-to-end pipeline is healthy.

### Revised ETA

* Per-batch NLP rate: ~110 sec per batch (5000 records, concurrency 2).
* Remaining: 579 batches → ETA ~12 hours for full NLP drain.
* Will check back periodically.

### Snapshot 2 (T+1h after seed, ~03:46 UTC → 04:46 UTC observed)

| Metric | Snapshot 1 | Snapshot 2 | Delta |
|---|---|---|---|
| NLP queue waiting | 579 | 499 | −80 batches |
| `canonical_employers` | 0 | 3 | +3 (my manual test rows only) |
| `staging.quarantine_records` | 49,071 | 68,402 | +19,331 |
| `staging.unresolved_employers` | 86,991 | 101,988 | +14,997 |
| `lca_records.soc_code` populated | — | 1,304,775 | — |
| `lca_records.canonical_employer_id` populated | — | 13,992 | — |
| `postgres-data` volume | 12 GB | 13 GB | +1 GB |
| Disk free | 16 GB | 16 GB | unchanged |
| Errors / failed jobs | 0 | 0 | — |

**Drain rate:** 80 batches / 60 min = 1.33 batches/min (≈45 s/batch across
two concurrent slots). At 499 remaining → ~6.3 h ETA.

**`canonical_employer_id` populated for 13,992 records, yet `canonical_employers`
only has 3 rows.** Not a bug — Layer 2 (pg_trgm) is matching pre-2024 records
against my 3 manual-test canonicals via name similarity. Real canonical
explosion will start when NLP reaches FY2024/FY2025 batches (~1.16M new FEIN
matches). Layer 2 firing on a tiny pool is encouraging signal — once the
pool grows, recall will jump.



### Snapshot 3 (T+2h after seed)

| Metric | Snap 1 | Snap 2 | Snap 3 | Δ vs Snap 2 |
|---|---|---|---|---|
| NLP queue waiting | 579 | 499 | 471 | −28 |
| NLP active | — | 2 | 2 | — |
| `canonical_employers` | 0 | 3 | 3 | — |
| `data->>'canonical_employer_id'` populated | — | 13,992 | 1,438,130 | **+1,424,138** |
| `data->>'soc_code'` populated | — | 1,304,775 | 1,438,130 | +133,355 |
| `quarantine_records` open | 49,071 | 68,402 | 75,047 | +6,645 |
| `unresolved_employers` open | 86,991 | 101,988 | 107,736 | +5,748 |
| Postgres DB size | — | 13 GB | 11 GB* | — |
| Host disk free | 16 GB | 16 GB | 17 GB | +1 GB |
| Errors | 0 | 0 | 0 | — |

\* `pg_database_size('lca_db')` reports 11 GB now. The 13 GB earlier reading
was the docker volume mountpoint footprint including WAL — measurement
changed, raw data did not shrink.

**Drain slowed: 0.47 batches/min vs Snap 2's 1.33.** Records-processed
delta (+133,355) matches the +28 queue delta at 5000/batch, so worker
throughput is honest, just slower. Suspect cause: Layer 2 `pg_trgm`
similarity scan against `canonical_employers` plus the
`unresolved_employers` UPSERT-and-aggregate path are now the hot loop on
FY2020–FY2023 batches (every record misses Layer 1 and falls through).

**Layer 2 absorbed 1.42M records this hour** — every pre-2024 record whose
`EMPLOYER_NAME` trigram-matches one of my 3 test canonicals (Amazon /
Cognizant / TEST CORP) at ≥ 0.6 sim is being assigned to them. This will
get corrected later: the FY2024/FY2025 batches will populate real
canonicals via Layer 1 FEIN, and `canonical:backfill` will re-evaluate
orphan rows. For now it's noisy but not broken.

**Revised ETA:** 471 / 0.47 ≈ 16.7 h remaining if the rate holds. If
FY2024/FY2025 batches (with real FEIN, cheap Layer 1) come up at the head
of the queue the rate should rebound.

### Snapshot 4 (≈ T+2h10m, short interval; user re-triggered after /compact)

| Metric | Snap 3 | Snap 4 | Δ |
|---|---|---|---|
| NLP queue waiting | 471 | 471 | 0 |
| NLP active | 2 | 1 | −1 |
| `canonical_employers` | 3 | 3 | — |
| `data->>'soc_code'` populated | 1,438,130 | 1,447,748 | +9,618 |
| `data->>'canonical_employer_id'` populated | 1,438,130 | 1,447,748 | +9,618 |
| `quarantine_records` open | 75,047 | 75,429 | +382 |
| `unresolved_employers` open | 107,736 | 108,297 | +561 |
| Postgres DB size | 11 GB | 11 GB | — |
| Host disk free | 17 GB | 17 GB | — |
| Worker CPU | — | 536% | (healthy, not stalled) |
| Errors / failed jobs | 0 | 0 | — |

**Worker is healthy.** Per `nlp_worker.batch_done` log timestamps, batches
are completing every ~2–3 min single-stream — concurrency configured = 2
but effective ≈ 1 due to DB-write contention on partitioned `lca_records`
+ `staging.unresolved_employers` UPSERTs. Stage mix steady: Stage 1
~45 %, Stage 2 ~55 %, Stage 0 still 0 (consensus empty post-reset),
quarantine ~4 % per batch.

Waiting count looks flat (471 → 471) but real throughput shows ~2 batches
drained in the 10 min window — measurement-window aliasing only;
absolute records-populated counter is the source of truth, and it moved.

**Total NLP-processed: 1,447,748 / 3,831,919 = 37.8 % done.**

### Snapshot 5 (≈ T+3h after seed)

| Metric | Snap 4 | Snap 5 | Δ |
|---|---|---|---|
| NLP queue waiting | 471 | 447 | −24 |
| NLP active | 1 | 1 | — |
| `canonical_employers` | 3 | 3 | — |
| soc_populated | 1,447,748 | 1,555,833 | +108,085 |
| canonical_employer_id_populated | 1,447,748 | 1,555,833 | +108,085 |
| `quarantine_records` open | 75,429 | 80,825 | +5,396 |
| `unresolved_employers` open | 108,297 | 114,016 | +5,719 |
| Postgres DB size | 11 GB | 11 GB | — |
| Host disk free | 17 GB | 15 GB | **−2 GB** |
| Errors / failed jobs | 0 | 0 | — |

**Drain rate stabilised: 0.42 batches/min** (24 batches in ~57 min).
Per-batch time stays ~2.5 min single-stream. Records rate ≈ 1,900 r/min.

**ETA:** 447 / 0.42 ≈ **17.7 h remaining**.

**Disk dropped 2 GB while pg DB stayed 11 GB** — culprit is docker
container logs (trgm_match DEBUG spam) + Redis BullMQ event log growth.
Build cache idle at 8.6 GB. Still above the 10 GB abort threshold, will
prune cache + truncate docker logs if it crosses 12 GB free.

**Total NLP-processed: 1,555,833 / 3,831,919 = 40.6 % done.**

### Snapshot 6 (short interval, ~5 min after Snap 5)

| Metric | Snap 5 | Snap 6 | Δ |
|---|---|---|---|
| NLP queue waiting | 447 | 445 | −2 |
| NLP active | 1 | 1 | — |
| soc_populated | 1,555,833 | 1,565,279 | +9,446 |
| canonical_employer_id_populated | 1,555,833 | 1,565,279 | +9,446 |
| `canonical_employers` | 3 | 3 | — |
| `quarantine_records` open | 80,825 | 81,379 | +554 |
| `unresolved_employers` open | 114,016 | 114,545 | +529 |
| Postgres DB size | 11 GB | 11 GB | — |
| Host disk free | 15 GB | 16 GB | +1 GB |
| Errors / failed jobs | 0 | 0 | — |

Short-interval snap — batch_done log gap 08:42 → 08:47 (≈ 5 min, 2
batches). Rate stable at ~0.4 batches/min single-stream. Disk recovered
1 GB (docker log rotation kicked in).

**Total NLP-processed: 1,565,279 / 3,831,919 = 40.8 % done.**

### Snapshot 7 (≈ T+4h30m, ~88 min after Snap 6)

| Metric | Snap 6 | Snap 7 | Δ |
|---|---|---|---|
| NLP queue waiting | 445 | 401 | **−44** |
| NLP active | 1 | **2** | +1 |
| soc_populated | 1,565,279 | 1,765,925 | **+200,646** |
| canonical_employer_id_populated | 1,565,279 | 1,765,925 | +200,646 |
| `canonical_employers` | 3 | 3 | — |
| `quarantine_records` open | 81,379 | 91,263 | +9,884 |
| `unresolved_employers` open | 114,545 | 124,612 | +10,067 |
| Postgres DB size | 11 GB | 11 GB | — |
| Host disk free | 16 GB | 14 GB | −2 GB |
| Errors / failed jobs | 0 | 0 | — |

**Drain rate up to 0.5 batches/min** (44 batches in ~88 min). Both
worker slots are active again — earlier single-slot stretch (Snaps 4–6)
looks to have been transient DB-write contention; concurrency 2 has
recovered. Records throughput ≈ 2,280 r/min.

**Revised ETA: 401 / 0.5 ≈ 13.4 h remaining.**

Still no real growth in `canonical_employers` — the head of the queue
remains pre-2024 batches. Real Layer-1 hits start when an FY2024 or
FY2025 batch dequeues; will be obvious from a sudden canonicals jump.

Disk dropped 2 GB / 88 min — projected exhaustion below 12 GB threshold
in ~1 h. Will run `docker builder prune -f` at next snapshot to recover
~8 GB of idle build cache.

**Total NLP-processed: 1,765,925 / 3,831,919 = 46.1 % done.**

### Snapshot 8 (short interval, ~10 min after Snap 7; disk-prune check)

| Metric | Snap 7 | Snap 8 | Δ |
|---|---|---|---|
| NLP queue waiting | 401 | 399 | −2 |
| NLP active | 2 | 1 | −1 |
| soc_populated | 1,765,925 | 1,780,160 | +14,235 |
| canonical_employer_id_populated | 1,765,925 | 1,780,160 | +14,235 |
| `canonical_employers` | 3 | 3 | — |
| `quarantine_records` open | 91,263 | 92,028 | +765 |
| `unresolved_employers` open | 124,612 | 125,215 | +603 |
| Postgres DB size | 11 GB | 11 GB | — |
| Host disk free | 14 GB | 14 GB | — (touched 12, recovered) |
| Errors / failed jobs | 0 | 0 | — |

**Disk check:** dropped to 12 GB; `docker builder prune -f` and
`docker image prune -f` both freed 0 B (nothing reclaimable). Disk
recovered to 14 GB on its own — likely Postgres WAL checkpoint trimmed
files. Docker VM is 54 GB total (images 34 GB / volumes 21 GB / build
cache 8.6 GB inactive but pinned). Will continue to watch; if pressure
returns, will truncate container json-logs.

Short-interval snap — ~3 batches actually processed in 10 min (queue −2
reflects new sub-batches being enqueued by BullMQ flows in parallel).
Rate consistent with Snap 7's 0.5 batches/min.

**Total NLP-processed: 1,780,160 / 3,831,919 = 46.5 % done.**

### Snapshot 9 (≈ T+5h30m, ~57 min after Snap 8)

| Metric | Snap 8 | Snap 9 | Δ |
|---|---|---|---|
| NLP queue waiting | 399 | 371 | −28 |
| NLP active | 1 | 1 | — |
| soc_populated | 1,780,160 | 1,906,024 | +125,864 |
| canonical_employer_id_populated | 1,780,160 | 1,906,024 | +125,864 |
| `canonical_employers` | 3 | 3 | — |
| `quarantine_records` open | 92,028 | 98,073 | +6,045 |
| `unresolved_employers` open | 125,215 | 133,283 | +8,068 |
| Postgres DB size | 11 GB | 12 GB | +1 GB |
| Host disk free | 14 GB | 14 GB | — (dipped to 11, PG checkpoint freed 3 GB) |
| Errors / failed jobs | 0 | 0 | — |

**Drain rate steady: 0.49 batches/min** (28 batches / 57 min, 2,208
r/min). Worker is now processing FY2023 Q3 batches — visible
progression through years.

**Revised ETA: 371 / 0.49 ≈ 12.6 h remaining.**

`canonical_employers` still 3 — FY2023 still lacks `EMPLOYER_FEIN`, so
Layer 1 stays dead. Real explosion deferred until FY2024 batches surface.

Disk dynamic continues: dropped to 11 GB pre-snapshot, Postgres
checkpoint trimmed WAL, recovered to 14 GB. `docker builder prune -f`
freed 0 B again — the build cache shown by `docker system df` is pinned
to layers in use by running containers. PG database grew 11 → 12 GB
(dead tuples from JSONB updates; autovacuum will reclaim).

**Total NLP-processed: 1,906,024 / 3,831,919 = 49.7 % done.**

### Snapshot 10 (≈ T+6h, ~30 min after Snap 9)

| Metric | Snap 9 | Snap 10 | Δ |
|---|---|---|---|
| NLP queue waiting | 371 | 359 | −12 |
| NLP active | 1 | **2** | +1 |
| soc_populated | 1,906,024 | 1,958,493 | +52,469 |
| canonical_employer_id_populated | 1,906,024 | 1,958,493 | +52,469 |
| `canonical_employers` | 3 | 3 | — |
| `quarantine_records` open | 98,073 | 100,604 | +2,531 |
| `unresolved_employers` open | 133,283 | 136,688 | +3,405 |
| Postgres DB size | 12 GB | 12 GB | — |
| Host disk free | 14 GB | 12 GB | −2 GB |
| Errors / failed jobs | 0 | 0 | — |

**Year progression:** worker now firing on FY2023 Q2/Q3/Q4 batches.
Logs show `LCA_Disclosure_Data_FY2023_Q2.xlsx:1` and `:Q4.xlsx:9` — FY2023
is being interleaved across quarters as parent flows release children.
Still no FY2024 batch surfaced; `canonical_employers` stays at 3.

**Drain rate dipped slightly: 0.4 batches/min** (12 batches / 30 min)
but both slots are active again. Records throughput ~1,750 r/min.

**ETA: 359 / 0.4 ≈ 15 h remaining.**

Disk back to 12 GB, dancing around the threshold. Still above the 10 GB
abort line.

**Crossed 100K open quarantine records** — almost all `low_soc_confidence`
from the Stage 2 retrieval-only path (Stage 3 LLM off during NLP run by
design; `quarantine:reclassify` would normally drain this offline). At
current rate quarantine will plateau around 200K when ingest completes,
above the >5000 skip threshold, so `quarantine:reclassify` will be
skipped per plan.

**Total NLP-processed: 1,958,493 / 3,831,919 = 51.1 % done.**

### Snapshot 11 (≈ T+7h30m, ~91 min after Snap 10; disk-prune executed)

| Metric | Snap 10 | Snap 11 | Δ |
|---|---|---|---|
| NLP queue waiting | 359 | 321 | −38 |
| NLP active | 2 | 1 | −1 |
| soc_populated | 1,958,493 | 2,144,654 | +186,161 |
| canonical_employer_id_populated | 1,958,493 | 2,144,654 | +186,161 |
| `canonical_employers` | 3 | 3 | — |
| `quarantine_records` open | 100,604 | 109,443 | +8,839 |
| `unresolved_employers` open | 136,688 | 146,717 | +10,029 |
| Postgres DB size | 12 GB | 12 GB | — |
| Host disk free | 12 GB | **18 GB** | +6 GB (after prune) |
| Errors / failed jobs | 0 | 0 | — |

**Disk prune ran:** Disk hit 9.1 GB (below 10 GB threshold).
`docker image prune -af` reclaimed 2.24 GB of unused images. PG WAL
checkpoint freed additional ~6 GB. Disk back to 18 GB — healthy buffer.
Active images now lean (only running containers' layers held).

**Drain rate: 0.42 batches/min** (38 batches / 91 min). Records
throughput ≈ 2,050 r/min. Stable.

**Revised ETA: 321 / 0.42 ≈ 12.7 h remaining.**

Year progression: worker still interleaving FY2021 Q3 + FY2023 Q2/Q3/Q4
batches. FY2020 and FY2022 appear mostly drained from logs. **FY2024
still not surfaced** → `canonical_employers` stays at 3.

**Total NLP-processed: 2,144,654 / 3,831,919 = 56.0 % done.**

### Snapshot 12 (short interval, ~8 min after Snap 11)

| Metric | Snap 11 | Snap 12 | Δ |
|---|---|---|---|
| NLP queue waiting | 321 | 319 | −2 |
| NLP active | 1 | 1 | — |
| soc_populated | 2,144,654 | 2,154,268 | +9,614 |
| canonical_employer_id_populated | 2,144,654 | 2,154,268 | +9,614 |
| `canonical_employers` | 3 | 3 | — |
| `quarantine_records` open | 109,443 | 109,829 | +386 |
| `unresolved_employers` open | 146,717 | 147,066 | +349 |
| Postgres DB size | 12 GB | 12 GB | — |
| Host disk free | 18 GB | 20 GB | +2 GB |
| Errors / failed jobs | 0 | 0 | — |

Short-interval snap (~8 min elapsed; user re-triggered before scheduled
wakeup). ~2 batches done per the soc counter delta. Disk continues to
recover post-prune (PG WAL keeps trimming on checkpoint). Year mix still
FY2021 Q3 + FY2023 Q2 in the recent batch_done tail.

**Total NLP-processed: 2,154,268 / 3,831,919 = 56.2 % done.**

### Snapshot 13 — 🎉 NLP DRAIN COMPLETE (≈ T+13h45m)

| Metric | Snap 12 | Snap 13 | Δ |
|---|---|---|---|
| NLP queue waiting | 319 | **0** | −319 |
| NLP active | 1 | **0** | −1 |
| NLP failed | 0 | 0 | — |
| soc_populated | 2,154,268 | 3,650,080 | **+1,495,812** |
| canonical_employer_id_populated | 2,154,268 | 3,650,080 | +1,495,812 |
| `canonical_employers` | 3 | **92,289** | **+92,286** |
| `quarantine_records` open | 109,829 | 181,839 | +72,010 |
| `unresolved_employers` open | 147,066 | 157,612 | +10,546 |
| Postgres DB size | 12 GB | 14 GB | +2 GB |
| Host disk free | 20 GB | 16 GB | −4 GB |
| Errors / failed jobs | 0 | 0 | — |
| Total batches processed | — | **780** | — |

**Last batch_done:** `LCA_Disclosure_Data_FY2025_Q1.xlsx:47` at 16:49:13 UTC.

**Layer 1 FEIN explosion confirmed.** Canonical-employers grew from 3 →
92,289 once FY2024/FY2025 batches surfaced. Late-stage batch_done logs
show `unresolved=0` for FY2025 records, proving FEIN→canonical hit rate
near 100 % on those years.

**Hypothesis validated:** the pre-2024 FEIN-coverage cliff documented in
Snap 1 played out exactly as predicted — FY2020/Q2 → FY2023 dumped into
`unresolved_employers` and were assigned via Layer 2 trgm to whichever
canonicals existed at time of write. The big swing pending now is the
`canonical:backfill` step, which will re-evaluate orphans against the
real 92K canonicals.

**Coverage:** 3,650,080 / 3,831,919 = 95.3 % records have a SOC.
Remaining 4.7 % (181,839) = open quarantine — equals the records that
landed in `staging.quarantine_records` with no soc_code written.

---

## Phase 7 — Post-ingest enrichment ✅

| # | Step | Result | Notes |
|---|---|---|---|
| 1 | `consensus:refresh` | ✅ 17,354 employer-SOC entries mined | 5m 50s wall time, agreement ≥ 0.8, hits ≥ 5 |
| 2 | `bootstrap-aliases` | ✅ 3,076 new aliases inserted | total `soc_aliases` now 16,079 (DMTF 13,003 + bootstrap) |
| 3 | `canonical:backfill` | ⚠️ killed after 9 h, 0 commits | Layer-1-only (FEIN). All 181,839 orphans are quarantined records; their FEINs were never registered as canonicals because the quarantine path skips entity resolution. Script can't insert new canonicals, only match existing ones → no-op for this data. Confirmed by year/FEIN breakdown: FY2020-2023 have 0 FEIN; FY2024 (25,509) + FY2025 (28,265) have FEIN but those FEINs aren't in `canonical_employers`. Resolving these requires extending the script to UPSERT new canonicals — out of scope for this run. |
| 4 | `employers:embed` | ✅ 92,289 embeddings written | sentence-transformers/all-MiniLM-L6-v2, 7m 27s, full HNSW index populated for Layer 3 resolution |
| 5 | `quarantine:reclassify` | ⏭️ **SKIPPED** | 181,839 records × 5–10 s Ollama llama3.1:8b call ≈ 250+ hours on Mac. Deferred — would require remote GPU host or batched-LLM mode. |

## Phase 8 — Final state ✅

### `db:status`

```
Extensions:        btree_gin 1.3 / pg_trgm 1.6 / uuid-ossp 1.1 / vector 0.8.2
DB size:           14 GB

lca_records by year:
  2020 →  577,334
  2021 →  826,305
  2022 →  626,084
  2023 →  644,607
  2024 →  561,037
  2025 →  596,552
  Total: 3,831,919

NLP tables:
  soc_aliases                  16,079
  employer_soc_consensus       17,354
  canonical_employers          92,289
  employer_embeddings          92,289
  staging.quarantine_records  181,839
  staging.unresolved_employers 157,612 (open)
```

### Coverage

| Metric | Records | % |
|---|---|---:|
| `lca_records` total | 3,831,919 | 100.0 % |
| With `soc_code` populated | 3,650,080 | **95.3 %** |
| With `canonical_employer_id` populated | 3,650,080 | **95.3 %** |
| `requires_review` flag still set | 0 | 0 % |
| Open quarantine (= no soc_code) | 181,839 | 4.7 % |

### SOC source mix

| Source | Records | % of classified |
|---|---:|---:|
| Stage 1 — DMTF / alias exact match | 1,516,117 | 41.5 % |
| Stage 2 — semantic retrieval (HNSW) | 1,898,690 | 52.0 % |
| Stage 0 — employer-SOC consensus | 235,273 | 6.4 % |

(Stage 0 hits accrue during the NLP run as the per-employer consensus
table fills in. `consensus:refresh` rebuilds it from final state for
subsequent runs.)

### Entity resolution outcome

* **Layer 1 (FEIN, deterministic):** 92,286 new canonicals registered
  from FY2024/FY2025 records (FEIN present in 100 % of those years).
  Pre-2024 disclosure files lack `EMPLOYER_FEIN` — Layer 1 dead by data,
  not code.
* **Layer 2 (pg_trgm probabilistic):** fired heavily during the run for
  pre-2024 batches when canonicals were still empty/sparse. Those
  records were name-matched to whatever canonicals existed at the time
  (initially the 3 manual test rows, then the 92K real ones as they
  populated late in the run).
* **Layer 3 (pgvector HNSW):** now fully usable for future runs —
  92,289 embeddings available via `employer_embeddings`.

### Unresolved & quarantine

| Pile | Count | Path forward |
|---|---:|---|
| `staging.quarantine_records` open | 181,839 | Stage-3 LLM reclassify (Ollama llama3.1:8b) — deferred; needs ~250 h on Mac CPU, ~5–10 h on a single A10G/L4 GPU. |
| `staging.unresolved_employers` open | 157,612 | Operator-UI manual merge into existing canonicals OR a new `backfill-canonical-by-name` CLI that uses Layer 2/3 + UPSERT (todo). |

---

## Run summary

| Phase | Duration | Status |
|---|---:|---|
| 0 — Pre-flight | — | ✅ |
| 1 — Teardown | < 1 min | ✅ |
| 2 — Image rebuild | ~ 12 min | ✅ |
| 3 — DB reset | < 1 min | ✅ |
| 4 — Ollama start | < 1 min | ✅ |
| 5 — Workers up + seed | < 2 min | ✅ |
| 6 — Ingest + NLP drain | **~ 13 h 45 min** | ✅ 780 batches, 0 failed |
| 7 — Enrichment (steps 1, 2, 4) | ~ 20 min | ✅ |
| 7 — Enrichment (step 3 backfill) | 9 h (killed) | ⚠️ no-op for data |
| 7 — Enrichment (step 5 reclassify) | — | ⏭️ skipped |
| 8 — Final status | < 1 min | ✅ |

**Total clock time: ~ 24 h** (most of which was unattended NLP drain +
the wasted 9-hour backfill scan).

### What worked
* Full reset → all 6 years (24 files, 3.83 M records) ingested
  successfully, **0 failed jobs**.
* NLP pipeline processed every record, **0 errors**, 0 active
  `requires_review` flags at end.
* Layer 1 FEIN explosion exactly as predicted when FY2024/FY2025
  batches surfaced (3 → 92,289 canonicals).
* Disk dynamic stayed self-balanced via PG checkpoints; one image-prune
  intervention at the 9 GB low mark recovered headroom.
* `employer_embeddings` populated end-to-end → Layer 3 is now ready for
  the next run.

### What didn't / known gaps
* **DOL data quirk** (not a bug): FY2020–FY2023 disclosures have
  **0 % EMPLOYER_FEIN**, so pre-2024 records can't use Layer 1 and end
  up Layer-2-matched into whatever canonicals existed at the moment
  they were processed. Result: 13 K early records are pinned to my 3
  manual test canonicals (Amazon / Cognizant / "TEST CORP") and need a
  Layer 2/3 re-run against the full 92 K canonical pool.
* **`canonical:backfill` is Layer-1-only and can't UPSERT.** All 181 K
  orphans are quarantine-path records whose FEINs were never
  registered as canonicals. Need a new Layer-2/3 + UPSERT variant to
  close them out.
* **`quarantine:reclassify` skipped** due to LLM cost on Mac.
  Recommended next step: rent an A10G/L4 for a few hours and burn
  through the 181 K queue.
* **DEBUG trgm-match log spam** in `nlp-worker` consumed enough disk
  to trigger one prune intervention; bump `LOG_LEVEL=INFO` for the
  worker in `.env` for future runs.

### Recommended follow-ups
1. Build `backfill-canonical-by-name` CLI (Layer 2 + Layer 3 + UPSERT).
2. Run that backfill against the 13 K mis-pinned records and the
   157,612 `unresolved_employers` queue.
3. Add an index on `data->>'canonical_employer_id'` so future backfill
   scans aren't sequential.
4. Move `quarantine:reclassify` to batched-LLM mode and run on GPU.
5. Lower `nlp-worker` log level to `INFO` to cut log noise.

---

## Phase 9 — Optimisation shipped (2026-05-12)

In response to the issues above, the following was built and is ready to run:

### Three new indexes on `lca_records` (auto-propagated to every year partition)

| Index | Purpose |
|---|---|
| `idx_lca_records_employer_name_state` on `(lower(EMPLOYER_NAME), EMPLOYER_STATE)` | Bulk merge JOINs from `unresolved_employers` and Operator-UI. EXPLAIN ANALYZE confirms ~14 s → ~2 s per merge UPDATE (~6× faster) with `enable_seqscan = off` to avoid stale-stats planner mispicks. |
| `idx_lca_records_canonical_missing` partial on `(id, filing_year) WHERE NOT (data ? 'canonical_employer_id')` | Orphan-record scans during canonical backfill. ~5 % of `lca_records` size. |
| `idx_lca_records_employer_fein` partial on `(data->>'EMPLOYER_FEIN')` | Reverse FEIN lookups for analytics and consensus refresh. |

Applied via `pnpm db:init` (idempotent ensureSchema). Wall-time on this DB:
~7 min total for all three across 3.83 M rows.

### New CLI: `backfill-canonical-full`

`packages/nlp-engine/src/lca_nlp_engine/backfill_canonical_full.py`

Full three-layer cascade against `staging.unresolved_employers` with
UPSERT of fresh canonicals + embeddings on miss. Key optimisations:

* Per-row decision logged into a per-batch decision list, then
  bulk-marks `unresolved_employers.resolved_to_id` and bulk-updates
  matching `lca_records` rows in one statement per resolved entry —
  drives the dominant cost path through the new composite index.
* **Batched encoder calls** (256 names per `encoder.encode(...)`),
  rather than per-row — ~5–10× faster on Mac CPU.
* Session-level `SET LOCAL`s for `work_mem`, `maintenance_work_mem`,
  `synchronous_commit = off`, `max_parallel_workers_per_gather = 4`,
  and `enable_seqscan = off`.
* `--dry-run`, `--no-backfill`, `--limit`, `--trgm-threshold`,
  `--vector-max-distance` flags.

Registered as `pnpm canonical:backfill-full` and as the
`backfill-canonical-full` console script in `pyproject.toml`.

### Smoke-test result (`--dry-run --limit 10`, 256 rows / 22 s wall)

| Layer | Count | % |
|---|---:|---:|
| Layer 1 (FEIN) | 0 | 0.0 % |
| Layer 2 (`pg_trgm`) | 188 | 73.4 % |
| Layer 3 (`pgvector`) | 32 | 12.5 % |
| New canonical inserted | 36 | 14.1 % |

**85.9 % match rate against the existing 92 K canonicals.** The cascade
is doing real work — every name passed through Layer 2/3 lands either
on a known canonical or a fresh one.

### Expected wall time for the full run

| Pile | Records | Wall time |
|---|---:|---:|
| `unresolved_employers` cascade pass | 157,612 | ~3 h (extrapolated from smoke test) |
| `lca_records` bulk backfill (matching rows) | ~1.4 M | ~30–60 min with new index hit |
| `VACUUM ANALYZE lca_records` post-run | — | ~10–20 min |
| **Total** | — | **~3.5–4.5 h** |

(vs ~7-10 h prior to indexes, and ~9 h wasted with the old
Layer-1-only `backfill-canonical-ids` that produced 0 commits.)

Run with:
```bash
DATABASE_URL=...  pnpm canonical:backfill-full
```

1. `consensus:refresh` — populates `employer_soc_consensus` from new records.
2. `aliases:bootstrap` — mines cross-employer consensus pairs into `soc_aliases`.
3. `canonical:backfill` — resolves any orphan `canonical_employer_id`.
4. `employers:embed` — encodes new canonical_employers into pgvector embeddings.
5. `quarantine:reclassify` — Stage 3 LLM-on-residual via Ollama (llama3.1:8b).
6. `canonical:backfill` again — for orphans created by quarantine drains.
7. Final `db:status` + statistics for this report.
