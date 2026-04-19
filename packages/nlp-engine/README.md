# lca-nlp-engine (Python)

Shared Python NLP library for the LCA Normalization Engine. Implements a hybrid
two-stage SOC code classifier, a three-layer employer Entity Resolution pipeline
backed by PostgreSQL 16 (`pg_trgm`, `pgvector`), and a Pydantic-validated async
BullMQ worker.

---

## Responsibilities

| Module | Purpose |
|---|---|
| `soc_classifier.py` | **Hybrid SOC classification**: Stage 1 — exact/normalised match against BLS DMTF (56k titles); Stage 2 — fine-tuned BERT fallback with confidence gating and `requires_review` flagging |
| `entity_resolution.py` | **3-layer employer deduplication**: Deterministic (FEIN regex) → Probabilistic (`pg_trgm` Jaccard > 0.6) → Semantic (pgvector HNSW); blocking by US State to prevent O(n²) comparisons |
| `worker.py` | Async Redis queue consumer; Pydantic-validates every incoming BullMQ message payload before dispatching to classifier or entity resolver |

---

## SOC Classification Pipeline

The classifier applies two stages in strict order. Stage 2 is only invoked when
Stage 1 produces no match. This minimises GPU/CPU usage on the transformer model —
the majority of common job titles resolve at Stage 1.

```
job_title (raw string)
      │
      ▼
┌─────────────────────────────────────────────────┐
│ Stage 1 — BLS DMTF Exact / Normalised Match     │
│                                                 │
│  1. Normalise: lowercase, strip punctuation,    │
│     expand common abbreviations                 │
│  2. Lookup in DMTF hash-map (56 000 titles)     │
│  3. If match → return SocPrediction             │
│     (confidence=1.0, source='dmtf')             │
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
│                      (source='bert')            │
│                                                 │
│  confidence < 0.7 → SocPrediction              │
│                      (requires_review=True)     │
│                      → staging.quarantine_records│
└─────────────────────────────────────────────────┘
```

### Confidence Gating & Human-in-the-Loop

Records where BERT confidence falls below **0.7** are never silently assigned a
low-quality SOC code. Instead:

1. `requires_review = True` is set on the `SocPrediction` dataclass.
2. The worker writes the record to `staging.quarantine_records` with
   `quarantine_reason = 'low_soc_confidence'` and the raw confidence score.
3. A human reviewer can inspect the quarantine table, correct the SOC code, and
   store the verified `(job_title, soc_code)` pair in the `soc_aliases` table.
4. On the next DMTF refresh cycle, confirmed aliases are merged into the Stage 1
   lookup map, progressively reducing BERT invocations over time.

---

## Entity Resolution Strategy

Employer name deduplication is a three-layer pipeline executed in precedence order.
Each layer produces a `canonical_employer_id`; the first layer to match wins.

### Layer 1 — Deterministic (FEIN)

Federal Employer Identification Number validation using the canonical regex:

```
^\d{2}-\d{7}$
```

Records with a valid, non-null FEIN are matched deterministically — no similarity
computation required. FEIN normalization (stripping spaces and dashes) is applied
before comparison to handle common formatting variants.

### Layer 2 — Probabilistic (`pg_trgm`)

For records without a reliable FEIN, trigram similarity on the `employer_name` field
is computed directly in PostgreSQL using the `pg_trgm` extension:

```sql
SELECT canonical_employer_id
FROM   core.canonical_employers
WHERE  similarity(employer_name, $1) > 0.6
ORDER  BY similarity(employer_name, $1) DESC
LIMIT  1;
```

Threshold **0.6 Jaccard similarity** balances recall (catching abbreviations, suffix
variants) against precision (avoiding cross-industry false matches). The
`gin_trgm_ops` index on `employer_name` makes this sub-linear even at millions of
distinct employers.

### Layer 3 — Semantic (pgvector HNSW)

Trigram matching misses semantic equivalences that differ in surface form
(e.g., `"JPMC"` vs `"JPMorgan Chase & Co."`). Layer 3 encodes employer names with
`sentence-transformers` (`all-MiniLM-L6-v2`, 384-dim) and performs approximate
nearest-neighbour search via the pgvector HNSW index:

```sql
SELECT canonical_employer_id
FROM   core.canonical_employers
ORDER  BY employer_embedding <=> $1   -- cosine distance operator
LIMIT  1;
```

A cosine distance threshold of **≤ 0.15** is used as the acceptance cutoff.
The HNSW index parameters (`m=16, ef_construction=64`) are tuned for the expected
cardinality of ~500k distinct employers in the 12M-record dataset.

### Blocking Strategy

Comparing every record against every known employer is O(n²) and computationally
infeasible at 12M records. The entity resolver applies a **blocking** strategy:
candidate comparisons are partitioned by `EMPLOYER_STATE` (and secondarily by
`EMPLOYER_POSTAL_CODE` prefix) before any similarity computation runs. This limits
each comparison set to same-state employer pairs, reducing candidate pairs by
approximately two orders of magnitude.

```
All records
    │
    ├── Block: employer_state = 'CA'  →  compare within CA only
    ├── Block: employer_state = 'NY'  →  compare within NY only
    ├── Block: employer_state = 'TX'  →  compare within TX only
    └── ...
```

Employers spanning multiple states (multi-site companies) are resolved by
propagating the canonical ID derived from the primary (highest-frequency) state
block to all other state occurrences.

---

## Worker — Pydantic Payload Validation

`worker.py` is an async Redis consumer compatible with BullMQ's internal job
serialisation format. Every message dequeued from Redis is parsed and validated
against a Pydantic v2 model **before** any business logic runs:

```python
class NlpJobPayload(BaseModel):
    batch_id:     str
    filing_year:  int
    job_type:     Literal['nlp:classify', 'er:deduplicate']
    records:      list[RecordItem]

class RecordItem(BaseModel):
    id:             int
    job_title:      str  = ''
    employer_name:  str  = ''
    employer_state: str  = ''
    employer_fein:  str  = ''
```

Malformed payloads (missing `batch_id`, wrong types, unknown `job_type`) raise a
`ValidationError` that is caught at the consumer boundary, logged with full field
detail, and the raw message is moved to the BullMQ DLQ without crashing the worker
process.

---

## Quick Start

```bash
# Create and activate virtual environment
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate

# Install (editable, with dev extras)
pip install -e ".[dev]"

# Run the NLP worker
NLP_MODEL_PATH=/app/models/soc-bert \
REDIS_URL=redis://localhost:6379 \
DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \
nlp-worker
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis / BullMQ connection |
| `DATABASE_URL` | — | PostgreSQL DSN (pg_trgm + pgvector queries) |
| `NLP_MODEL_PATH` | `/app/models/soc-bert` | Path to fine-tuned BERT checkpoint |
| `DMTF_PATH` | `/app/data/dmtf.csv` | BLS Direct Match Title File (CSV) |
| `SOC_CONFIDENCE_THRESHOLD` | `0.7` | BERT confidence cutoff below which `requires_review=True` |
| `ER_TRGM_THRESHOLD` | `0.6` | pg_trgm Jaccard similarity threshold for Layer 2 |
| `ER_VECTOR_DISTANCE_MAX` | `0.15` | pgvector cosine distance cutoff for Layer 3 |
| `ER_EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | sentence-transformers model for employer embeddings |
| `NLP_WORKER_CONCURRENCY` | `2` | Parallel async job slots |
| `NLP_DEVICE` | `cpu` | `cpu` or `cuda` |

---

## Model Training

### SOC Classifier

The BERT checkpoint is fine-tuned on `(job_title, soc_code)` pairs as a
`text-classification` task (one label per SOC 6-digit code).

**Training dataset construction:**

1. **Primary source — BLS DMTF**: The Direct Match Title File ships with 56,000
   pre-labelled `(title, SOC code)` pairs. This is the foundation of the training set.
2. **Augmentation — historical LCA records**: Export `(JOB_TITLE, SOC_CODE)` pairs
   from `staging.raw_lca_data` where `SOC_CODE` is non-null and well-formed. These
   provide domain-specific job title variants (e.g., `"Sr. SW Eng III"`) absent from
   the DMTF.
3. **Alias table**: Human-reviewed corrections from `staging.quarantine_records`
   (low-confidence predictions later verified) are merged back as additional training
   examples on each retraining cycle.

**Fine-tuning:**

```bash
# Using HuggingFace Trainer
python -m lca_nlp_engine.train_soc \
  --base-model bert-base-uncased \
  --train-file data/soc_train.jsonl \
  --output-dir /app/models/soc-bert \
  --epochs 5 \
  --batch-size 32
```

Save with `model.save_pretrained()` and update `NLP_MODEL_PATH` to point at the
output directory.

### Entity Resolution

Layer 2 (`pg_trgm`) and Layer 3 (pgvector) require no separate training step —
they operate directly on PostgreSQL indexes. The `gin_trgm_ops` and HNSW indexes
are created by `@lca/db-lib`'s `ensureSchema()` during DB initialisation.

The `dedupe` library (used in earlier prototypes) is superseded by the three-layer
PostgreSQL-native approach described above and is retained only as a fallback for
offline batch experiments where a live database connection is unavailable.
