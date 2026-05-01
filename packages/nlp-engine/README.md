# lca-nlp-engine (Python)

Shared Python NLP library for the LCA Normalization Engine. Implements a two-stage
SOC code classifier backed by a PostgreSQL `soc_aliases` table and a fine-tuned BERT
model, a three-layer employer Entity Resolution pipeline, Pydantic-validated BullMQ
job payloads, and a `load-dmtf` CLI for seeding the SOC alias table from the BLS
Direct Match Title File.

---

## Modules

| Module | Purpose | Status |
|---|---|---|
| `models.py` | Pydantic v2 schemas: `RecordItem`, `NlpJobPayload`, `SocResult` | ✅ Complete |
| `dmtf_loader.py` | Downloads/parses BLS DMTF Excel file and bulk-upserts into `soc_aliases` | ✅ Complete |
| `soc_classifier.py` | Two-stage SOC classifier: DMTF exact match → BERT fallback | Stage 1 ✅ / Stage 2 stub |
| `entity_resolution.py` | 3-layer employer deduplication (FEIN → pg_trgm → pgvector) | Stub |
| `worker.py` | Async Redis/BullMQ consumer with Pydantic validation | ✅ Complete |

---

## SOC Classification Pipeline

The classifier applies two stages in strict order. Stage 2 is invoked only when
Stage 1 produces no match, minimising model inference calls.

```
job_title (raw string)
      │
      ▼
┌─────────────────────────────────────────────────┐
│ Stage 1 — BLS DMTF Exact Match (PostgreSQL)     │
│                                                 │
│  SELECT soc_code, soc_title                     │
│  FROM   soc_aliases                             │
│  WHERE  lower(job_title) = lower($input)        │
│                                                 │
│  hit  → SocPrediction(confidence=1.0)           │
│  miss → Stage 2                                 │
└─────────────────────────┬───────────────────────┘
                          │ no match
                          ▼
┌─────────────────────────────────────────────────┐
│ Stage 2 — Fine-tuned BERT (text-classification) │
│                                                 │
│  model: bert-base-uncased fine-tuned on         │
│         (job_title, soc_code) pairs             │
│                                                 │
│  confidence ≥ 0.7 → SocPrediction              │
│  confidence < 0.7 → SocPrediction              │
│                      (requires_review=True)     │
│                      → staging.quarantine_records│
└─────────────────────────────────────────────────┘
```

### Seeding Stage 1

`soc_aliases` must be populated before the NLP worker starts. Run once after
`pnpm db:init`.

**Source files** (public BLS datasets):

| Edition | URL |
|---|---|
| 2018 SOC *(recommended — current DOL standard)* | `https://www.bls.gov/soc/2018/soc_2018_direct_match_title_file.xlsx` |
| 2010 SOC *(for pre-2020 historical records)* | `https://www.bls.gov/soc/soc_2010_direct_match_title_file.xls` |

```bash
# Option A — download automatically from BLS (requires outbound internet)
DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \
  load-dmtf --url

# Option B — download manually, then load from file
curl -o dmtf.xlsx "https://www.bls.gov/soc/2018/soc_2018_direct_match_title_file.xlsx"
DATABASE_URL=postgresql://... load-dmtf --file ./dmtf.xlsx
```

The loader auto-detects 2018 vs 2010 column layouts. The command is
idempotent — re-running after a new DMTF release safely upserts updated
mappings without creating duplicates.

### Confidence Gating & Human-in-the-Loop

Records where BERT confidence falls below **0.7** are never silently assigned a
low-quality SOC code. Instead, `requires_review = True` is set on `SocResult`
and the record is routed to `staging.quarantine_records`. Human reviewers can
correct the SOC code and insert verified `(job_title, soc_code)` pairs into
`soc_aliases`, progressively shrinking the set of titles that need BERT.

---

## Entity Resolution Strategy

Employer name deduplication is a three-layer pipeline applied in precedence order.
The first layer to match wins and writes `canonical_employer_id` back to
`lca_records`.

### Layer 1 — Deterministic (FEIN) — *stub, next to implement*

Federal Employer Identification Number match using the canonical regex
`^\d{2}-\d{7}$`. Records with a valid FEIN are matched deterministically —
no similarity computation required.

### Layer 2 — Probabilistic (`pg_trgm`) — *stub*

For records without a reliable FEIN, trigram similarity on `employer_name` is
computed in PostgreSQL using the `pg_trgm` extension:

```sql
SELECT id
FROM   canonical_employers
WHERE  similarity(canonical_name, $1) > 0.85
ORDER  BY similarity(canonical_name, $1) DESC
LIMIT  1;
```

The `gin_trgm_ops` index on `canonical_name` keeps this sub-linear at scale.

### Layer 3 — Semantic (pgvector HNSW) — *stub*

Employer names are encoded with `sentence-transformers` (`all-MiniLM-L6-v2`,
768-dim) and stored in `employer_embeddings`. Approximate nearest-neighbour
search is performed via the pgvector HNSW index:

```sql
SELECT employer_id
FROM   employer_embeddings
ORDER  BY embedding <=> $1   -- cosine distance
LIMIT  1;
```

A cosine distance threshold of **≤ 0.15** is used as the acceptance cutoff.

### Blocking Strategy

Candidate comparisons are partitioned by `EMPLOYER_STATE` before any similarity
computation runs, reducing the comparison space by ~2 orders of magnitude.

---

## Pydantic Models (`models.py`)

Every BullMQ message dequeued from Redis is validated before any ML or DB work
begins. Malformed payloads are logged and rejected without touching `lca_records`.

```python
class RecordItem(BaseModel):
    id:             int              # lca_records primary key
    filing_year:    int
    job_title:      str
    employer_name:  str
    employer_state: str | None       # normalised to 2-char uppercase
    employer_city:  str | None
    fein:           str | None       # validated: ^\d{2}-\d{7}$ or None
    soc_code:       str | None

class NlpJobPayload(BaseModel):
    batch_id: str
    records:  list[RecordItem]       # model_validator rejects duplicate ids

class SocResult(BaseModel):
    id:                   int
    soc_code:             str
    soc_title:            str
    soc_confidence:       float      # 0.0–1.0
    requires_review:      bool       # True when confidence < 0.7
    canonical_employer_id: UUID | None
```

---

## Quick Start

```bash
# 1. Create and activate virtual environment
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate

# 2. Install (editable, with dev extras)
pip install -e ".[dev]"

# 3. Start infrastructure (from monorepo root)
pnpm docker:up
pnpm db:init

# 4. Seed the SOC alias table (required before starting the worker)
DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \
load-dmtf --url

# 5. Run the NLP worker
NLP_MODEL_PATH=/app/models/soc-bert \
REDIS_URL=redis://localhost:6379 \
DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \
nlp-worker
```

---

## CLI Commands

| Command | Description |
|---|---|
| `nlp-worker` | Start the async BullMQ worker |
| `load-dmtf --url` | Download BLS 2018 DMTF and populate `soc_aliases` |
| `load-dmtf --file <path>` | Load DMTF from a local `.xlsx` file |
| `classify-soc --model <path>` | Classify job titles from a JSONL stream |
| `dedup-companies --db <dsn>` | Run employer entity resolution (stub) |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis / BullMQ connection |
| `DATABASE_URL` | — | PostgreSQL DSN — required for Stage 1 DMTF lookup and entity resolution |
| `NLP_MODEL_PATH` | `/app/models/soc-bert` | Path to fine-tuned BERT checkpoint directory |
| `NLP_WORKER_CONCURRENCY` | `2` | Parallel async job slots |
| `NLP_DEVICE` | `cpu` | `cpu` or `cuda` |

---

## Model Training

### SOC Classifier

The BERT checkpoint is fine-tuned on `(job_title, soc_code)` pairs as a
`text-classification` task (one label per 6-digit SOC code).

**Training data sources:**

1. **BLS DMTF** — 56K pre-labelled `(title, SOC code)` pairs; the foundation of the training set.
2. **Historical LCA records** — `(JOB_TITLE, SOC_CODE)` pairs from `lca_records` where `SOC_CODE` is non-null; provides domain-specific title variants absent from the DMTF.
3. **Quarantine corrections** — human-verified pairs from `staging.quarantine_records`, merged on each retraining cycle.

```bash
python -m lca_nlp_engine.train_soc \
  --base-model bert-base-uncased \
  --train-file data/soc_train.jsonl \
  --output-dir /app/models/soc-bert \
  --epochs 5 \
  --batch-size 32
```

### Entity Resolution

Layers 2 and 3 require no separate training — they operate directly on
PostgreSQL indexes (`gin_trgm_ops`, HNSW) created by `ensureSchema()`.
