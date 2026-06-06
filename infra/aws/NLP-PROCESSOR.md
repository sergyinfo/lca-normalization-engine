# Decoupled NLP processor — DEPLOYED (mode-branch on the burst stack)

Status: **DEPLOYED 2026-06-06** to `LcaDataPipelineStack`. Implemented as a *mode branch*
on the existing burst launch template (not a separate template) to reuse the proven
bootstrap/SFN/single-flight and keep the change additive — the normal `Mode=ingest` path
is untouched. The deploy added **no running instance** (cost is only at trigger time).

## How to trigger it
Fire a `lca.manual` / `nlp.run` EventBridge event (same single-flight guard as the burst
— it won't start if a burst/processor is already running):
```
aws --profile h1b-report events put-events --entries '[{
  "Source":"lca.manual","DetailType":"nlp.run",
  "Detail":"{\"mode\":\"nlp-processor\",\"instanceType\":\"c7g.8xlarge\",\"nlpReplicas\":\"8\"}"
}]'
```
The box boots → reads its `Mode`/`NlpReplicas` tags → runs `nlp-processor.sh`:
restore snapshot → `db:init` → `--scale nlp-worker=8` → sweep (100% enqueue) → drain →
`nlp-finalize.sh` (rebuild candidate + **re-snapshot** + SNS "promotable") → self-terminate.
36h watchdog applies (drain ≈ 11h on 8 replicas, comfortably inside it).

> Runtime scripts (`nlp-processor.sh`, `docker-compose.yml`) are cloned from `develop` at
> launch — they MUST be merged to develop before firing `nlp.run`.

## Original design notes (superseded by the mode-branch above, kept for context)

## Why
The burst box ingests all years and builds the candidate in **hours**, but classifying
a ~6M-row backfill at ~90k rows/hr is **~65 hours** — far past the 36h review-box
watchdog. And the burst's PG snapshot is taken with NLP **deferred** (≈16% classified),
so promoting it would ship mostly-unclassified SOC. Decision (with user): **decouple**
the slow NLP onto its own long-lived, cheap (spot) box that persists the finished work.

## Flow
```
all-years burst (DeferNlp=true, bigger box)
  → ingest 2010–2019 + restore 2020–2025 → snapshot PG → candidate (row counts) → review → tear down
        │  snapshot = raw+ingested, NLP partial
        ▼
NLP processor (spot, days)  ── infra/aws/scripts/nlp-processor.sh ──
  restore snapshot → db:init(floor 2010) → nlp-worker
  → sweep-enqueue (100% coverage) → drain nlp-tasks to empty (≤ DRAIN_MAX_HOURS)
  → nlp-finalize.sh: rebuild candidate + summaries + **re-snapshot PG** + dev preview + SNS "promotable"
  → self-terminate
        │  snapshot now = fully classified
        ▼
operator Promote (or next burst) → prod  ⇒ prod stable WITH all-years data
```

## Scripts (done, committed, `bash -n` clean)
- `apps/ingestor/sweep-enqueue.mjs` — guaranteed NLP enqueue (ingest's per-batch enqueue
  is best-effort; the FY2018/19 run proved ~40% can be missed). Reads base64'd JSONL.
- `infra/aws/scripts/nlp-processor.sh` — the orchestration (restore → sweep → drain → finalize → terminate).
- `infra/aws/scripts/nlp-finalize.sh` — rebuild candidate + **re-snapshot** (the persist step) + notify. Reuses the proven burst-finalize fixes (DATABASE_URL, constructed ECR URI), minus the operator-ui/Caddy review env.

## CDK to add (in `infra/aws/lib/data-pipeline-stack.ts` — TODO, review first)
Reuse the existing `ec2Role`, `vpc`, `sg`, secrets, and log groups — the role already
grants everything the processor needs (S3 RW, pgSnapshot bucket, secrets, ECR push,
`ec2:TerminateInstances` on `BurstWorker=true`, Lambda update, SNS). Add:

1. **Launch template `lca-nlp-processor`** — arm64 AL2023, same role/sg, default
   `c7g.4xlarge` (more vCPU = more NLP workers = fewer days). User-data = the SAME
   bootstrap block as the burst (CW agent, docker, node 22, pnpm, clone `develop`,
   `pnpm install`) + arm a **longer watchdog** (e.g. `sleep 259200` = 72h) + then:
   ```
   docker compose up -d db redis      # nlp-processor.sh restores into these
   NOTIFY_TOPIC=… LLM_SECRET=… LCADB_BUCKET=… ECR_REPO=… PGSNAP_BUCKET=… \
     REGION=$REGION RELEASE=$(date -u +%Y%m%d-%H%M%S) INSTANCE_ID=$INSTANCE_ID \
     NLP_WORKER_CONCURRENCY=12 \
     bash /opt/lca/infra/aws/scripts/nlp-processor.sh
   ```
2. **Spot** — `spotOptions` on the launch template (interruption-tolerant: a restart
   re-restores the snapshot and re-sweeps the still-unclassified rows, so it's safe).
   Tag `BurstWorker=true` (for self-terminate) + `NlpProcessor=true` (to distinguish).
3. **Trigger** — an EventBridge rule on `lca.manual` / `nlp.run` → Step Functions with
   the SAME single-flight `CheckBurstRunning`-style guard filtered on `NlpProcessor=true`
   (never two processors). Fire it from `upload-dol.sh` (add an `--nlp-run` mode) or by
   hand once the all-years burst's review looks good.
4. **Watchdog** — 72h inline (vs the burst's 36h), since a full backfill drain can take
   ~1–3 days depending on box size / spot interruptions.

## Cost
Dominated by the processor box-hours: ~6M rows ÷ throughput. On **spot** c7g.4xlarge
(~$0.20–0.30/hr) for ~30–35h ≈ **$7–11**. Self-terminates on completion; 72h watchdog
caps a stuck/forgotten box. No always-on cost added (launched on demand only).

## Throughput — profiled 2026-06-06 (READ THIS before sizing)
- **Primary bug found + FIXED** (commit on branch): the nlp-worker was in a Docker
  restart loop (`RestartCount=349`) — the job-pull `brpoplpush` sat outside the
  try/except, so any transient redis/queue hiccup killed `run()`, the process exited,
  and `restart: always` reloaded the BERT model (~19s) every ~26s → ~75% of CPU wasted,
  throughput ~10/s. Hardened (loop guard + pull inside try). After fix: RestartCount
  stable 0, ~**19 rec/s (~70k/hr)** measured.
- **Secondary, NOT fixed:** even hardened, the worker only hits ~29% CPU. "concurrency=6"
  is **asyncio** concurrency in ONE process — `classifier.predict_batch` + the per-record
  `deduplicator.resolve` are SYNCHRONOUS/blocking, so they serialize on the event loop
  (the 751% seen earlier was torch's internal BLAS threads for ONE batch). **Real
  parallelism needs multiple worker PROCESSES (container replicas), not asyncio
  concurrency.** So scale the processor with N `nlp-worker` replicas, each a process.

## Open items / decisions
- **Scale via replicas, not NLP_WORKER_CONCURRENCY:** on a c7g.8xlarge (32 vCPU) run
  ~6–8 `nlp-worker` replicas (compose `--scale nlp-worker=8` or deploy.replicas) →
  ~6–8× the single-process ~70k/hr. Est: 6M rows ÷ (8×70k/hr) ≈ **~11h**; on one process
  it's ~85h (~3.5 days). The 72h watchdog must exceed the chosen box's drain time.
- **Spot interruption mid-drain:** safe by design (idempotent restore+sweep), but the
  re-restore loses in-flight write-back since the burst snapshot — acceptable (re-swept).
  If we want incremental durability, add a periodic re-snapshot inside the drain loop.
- **db:init partition floor** must be lowered to 2010 for the all-years run (it's 2018
  now). Confirm `LCA_PARTITION_START_YEAR=2010` on both the burst and the processor.
- **DRAIN_MAX_HOURS=60** backstop — raise if a single-box drain proves slower.
