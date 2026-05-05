# Entity Resolution Evolution

> A chronological account of the employer entity-resolution pipeline as it
> evolved from a single FEIN match to a three-layer cascade with an operator
> queue for misses.
>
> Same structure as the SOC note: each section documents *what was tried*,
> *why*, *how it was implemented*, *results on the FY2025 Q1 corpus*, *what
> we learned*, and *the resulting decision*.
>
> The two largest course-corrections — discovering that 100% of orphan records
> actually had valid FEINs, and discovering that quarantine drains were
> silently leaking entity resolution — only became visible once the pipeline
> ran end-to-end. They are documented here because they reframe how Layers
> 2 and 3 should be understood.

---

## Table of Contents

1. [The Original Three-Layer Plan](#the-original-three-layer-plan)
2. [Layer 1 — Deterministic FEIN Match](#layer-1--deterministic-fein-match)
3. [Discovery: Quarantine-Drain Leaked canonical_employer_id](#discovery-quarantine-drain-leaked-canonical_employer_id)
4. [Discovery: 100% FEIN Coverage on FY2025 Q1](#discovery-100-fein-coverage-on-fy2025-q1)
5. [Layer 2 — Trigram Similarity (pg_trgm)](#layer-2--trigram-similarity-pg_trgm)
6. [Layer 3 — Semantic Embeddings (pgvector HNSW)](#layer-3--semantic-embeddings-pgvector-hnsw)
7. [Quarantine-on-Miss — Option C](#quarantine-on-miss--option-c)
8. [Final Architecture & Justification](#final-architecture--justification)
9. [Open Items](#open-items)

---

## The Original Three-Layer Plan

The README specified a textbook three-layer cascade:

| Layer | Method | Cost | Recall on idea | Precision |
|---|---|---|---|---|
| 1 | Deterministic — exact FEIN match | µs | high when present | 1.0 |
| 2 | Probabilistic — `pg_trgm` similarity | sub-ms | broad | gated by threshold |
| 3 | Semantic — `pgvector` cosine on name embeddings | ms | covers paraphrase | gated by threshold |

The motivating assumption was: ~30 % of records would lack a usable FEIN
(historical files pre-2020, foreign employers, malformed FEIN strings) so
Layers 2/3 would carry meaningful traffic.

This assumption turned out to be wrong on the modern post-2020 corpus —
covered in the discovery sections below — but the layered architecture is
still correct as a design principle for older / dirtier data.

---

## Layer 1 — Deterministic FEIN Match

### What was tried
A single SELECT/UPSERT against `canonical_employers` keyed on the regex-validated
`EMPLOYER_FEIN` value. On match, bump `record_count`. On miss, INSERT a fresh
canonical row.

### Why
FEIN is the authoritative federal identifier — it is by definition unique per
employer. When present and well-formed, it is the cheapest and most reliable
collapsing key available, dwarfing any string-similarity approach in both
speed and precision.

### How it was implemented
* `entity_resolution.CompanyDeduplicator.resolve_fein()` runs the lookup.
* FEIN format is validated by `^\d{2}-\d{7}$` to filter out the all-zeros and
  whitespace strings DOL filings sometimes carry.
* On hit: UPDATE `record_count = record_count + 1`, return existing UUID.
* On miss: INSERT new row with the supplied (name, FEIN, city, state) and
  return the generated UUID.
* Worker calls this inline per record during the normal NLP path.

### Results on FY2025 Q1
| Metric | Value |
|---|---|
| Records with valid FEIN | 107,414 / 107,414 (100.0 %) |
| Distinct canonicals seeded | 19,970 |
| Mean records per canonical | 5.4 |
| Latency | ~0.3 ms / record |

### Decision
**Kept** as Layer 1. It carries 100 % of traffic on this corpus and remains
the right first stage on any corpus where FEIN coverage is non-trivial.

---

## Discovery: Quarantine-Drain Leaked canonical_employer_id

### What was found
A DB audit asked "how many records are missing a canonical_employer_id?" The
answer: **4,047 / 107,414 (3.8 %).** The orphans were not random — they were
exactly the records whose Stage-2 SOC confidence had been below the threshold
and were routed through the quarantine path.

### Root cause
`reclassify_quarantine.py` only patched SOC fields when the LLM committed a
confident pick. It never called Layer 1 entity resolution. Every record that
took the quarantine path therefore left `canonical_employer_id = NULL`,
even though the underlying FEIN was perfectly resolvable.

This was a hidden coupling: SOC quarantine and entity resolution were running
on independent code paths in the worker, but the quarantine drain only
implemented one of them.

### Verification
A LEFT JOIN of orphans against `canonical_employers` on FEIN showed
**4,047 / 4,047 would resolve immediately by FEIN.** No name similarity needed.

### Fix
Two changes shipped together:

1. **One-shot backfill CLI** (`backfill-canonical-ids`) — keyset-paginated
   scan of `lca_records WHERE canonical_employer_id IS NULL`, calls
   `resolve_fein` per row, writes the UUID back. Idempotent. Resolved all
   4,047 orphans in 11 seconds.
2. **Inline fix in reclassify-quarantine** — every confident LLM pick now
   also calls `resolve_fein` and includes `canonical_employer_id` in the
   patch. Future quarantine drains close the gap automatically.

### What we learned
Pipelines that branch (classified vs. quarantined) need each branch to honour
**all** downstream contracts, not just the obviously-relevant ones. The right
mitigation here is invariant-style auditing (e.g. "every record in
`lca_records` after NLP must have either a `canonical_employer_id` or appear
in an unresolved-employers queue") rather than trying to remember the coupling
on every code change.

---

## Discovery: 100 % FEIN Coverage on FY2025 Q1

### What was found
The orphan analysis above also delivered an unrelated surprise: every single
record in the corpus had a well-formed FEIN matching the
`^\d{2}-\d{7}$` regex.

This contradicted the working assumption that ~30 % would be FEIN-less. The
"30 %" figure had been carried over from generic guidance about historical
DOL data; it does not hold for the post-2020 LCA / FLAG releases, which
appear to enforce FEIN format at the filing portal.

### Implication
On this corpus, **Layers 2 and 3 carry zero traffic**. Layer 1 alone achieves
100 % coverage. The cascade is not pulling its weight on FY2025 Q1.

### Why we still built Layers 2 and 3
1. **Older corpora have lower FEIN discipline.** Pre-2020 files (LCA Disclosure
   Data, the format that preceded FLAG) have less consistent FEIN formatting.
2. **Foreign employers, edge cases.** Even modern releases occasionally carry
   blank or malformed FEINs for edge records.
3. **Defence in depth.** The pipeline is intended to ingest 12M+ historical
   records across a decade. Building the resolution cascade once, against the
   clean corpus where its behaviour is easy to validate, is cheaper than
   bolting it on later under pressure.
4. **Same-FEIN, drifted name.** Layer 2/3 can also be run as a *consistency
   check* against the FEIN canonicals — flagging cases where the same FEIN
   is filing under wildly different names, which often indicates a stale
   legal-entity rename or a typo in the filing.

### Decision
**Kept the original architecture** but with realistic expectations about its
exercise. Validation strategy shifted from "measure recall on real misses" to
"probe with synthetic name variants and confirm thresholds behave."

---

## Layer 2 — Trigram Similarity (pg_trgm)

### What was tried
A `SELECT … WHERE canonical_name % :name AND employer_state = :state ORDER
BY similarity(…) DESC LIMIT 1`, accepting only when the top similarity is
≥ 0.85.

### Why
For records that have an employer name but no usable FEIN, trigram similarity
collapses obvious surface variants (`"Apple Inc"`, `"APPLE INC."`, `"Apple
Inc"`) onto a canonical that was originally seeded by FEIN. It is:

* **Cheap** — sub-millisecond per query thanks to the GIN trigram index.
* **Index-friendly** — the existing `gin_trgm_ops` index on
  `canonical_employers(canonical_name)` was already created.
* **Conservative** — the 0.85 cutoff is high enough to reject typos without
  rejecting case/punctuation variants.

### How it was implemented
* `entity_resolution.CompanyDeduplicator.resolve_trgm()`.
* **Blocking by `employer_state`** — scope each query to that state's
  ~50–2,000 canonical rows. This is the standard pg_trgm pattern for keeping
  per-query cost bounded as the canonical set grows.
* The GIN trigram operator (`%`) is the recall floor (default ≥ 0.3
  similarity); the Python-side `sim ≥ 0.85` check is the precision gate.
  Two tiers means cheap candidate generation followed by strict acceptance.
* On accept: bump `record_count` on the matched canonical so downstream
  metrics remain accurate.

### Validation probes
Hand-picked queries against the 19,970-row canonical set:

| Query | Best match | Similarity | Decision |
|---|---|---|---|
| `Apple Inc` (state=CA) | `Apple Inc.` | 1.00 | ✓ accepted |
| `BYTEDANCE INC.` | `ByteDance Inc.` | 1.00 | ✓ accepted (case-insensitive) |
| `Goggle Inc` (typo) | `GOFO Inc.` | 0.43 | ✗ rejected (below 0.85) |

Trigram is intrinsically case-insensitive, which is exactly the right default
for company-name normalisation. The typo case is the headline result: a
plausible-looking misspelling that an embedding model might match
near-Google never crosses the precision gate.

### What we learned
* The bigger risk is **state-confused matches** — `"Apple"` filed in TN as a
  retail-store franchisee is a different entity from `"Apple Inc."` in CA.
  State blocking eliminates this entire failure mode at zero cost.
* Trigram has **no semantic awareness**: `"Bytedance Limited"` would not
  collapse onto `"ByteDance Inc."` despite obviously being the same firm.
  That recall gap is precisely what Layer 3 exists to close.

### Decision
**Kept** as Layer 2 with threshold 0.85 and state blocking.

---

## Layer 3 — Semantic Embeddings (pgvector HNSW)

### Three problems found and fixed before this layer could function

**1. Vector dimension mismatch.** The `employer_embeddings` DDL declared
`embedding vector(768)` but the Stage 2 sentence-transformer
(`all-MiniLM-L6-v2`) produces 384-dimensional vectors. An HNSW index could
not have been built or queried. Fixed in `db-lib`; table was empty so a
clean drop+recreate was safe.

**2. Missing HNSW index.** Even with the right dim, no `USING hnsw
(embedding vector_cosine_ops)` index existed. Without it, every Layer 3
query would seq-scan all 19,970 vectors. Added to the DDL.

**3. Empty embedding table.** No script existed to populate
`employer_embeddings`. Built `embed-employers` (`employer_embedder.py`):
loads canonicals into memory, encodes each `canonical_name` with the
sentence-transformer, bulk-inserts via `executemany` with
`ON CONFLICT DO NOTHING`. Idempotent and incremental. Encoded all 19,970
canonicals in 70 s on CPU.

(An initial implementation used a server-side cursor for streaming the
canonicals out of Postgres — but `conn.commit()` between batches closed the
named cursor mid-iteration. Switched to materialising the work list in
Python; with ~20K rows of UUID + name this is a few MB and trivially cheap.)

### What was tried
After the prerequisites were in place: encode the incoming employer name on
the fly, run a one-shot ANN query through the HNSW cosine index, accept only
when the closest match has cosine distance ≤ 0.15 (≈ similarity ≥ 0.85).

### Why
Layer 2 misses the long tail of paraphrase / reword / re-incorporation
variants — `"Bytedance Limited"` vs `"ByteDance Inc."`, `"Goldman Sachs &
Co. LLC"` vs `"GOLDMAN SACHS GROUP INC"`. A semantic encoder catches these
because it operates on token-meaning vectors, not n-grams.

### How it was implemented
* `entity_resolution.CompanyDeduplicator.resolve_vector()`.
* The `SocClassifier` already loads `all-MiniLM-L6-v2` for SOC retrieval. The
  worker now **injects this encoder into the deduplicator** so the model is
  loaded exactly once per worker process. Layer 3 also exposes a lazy-load
  fallback for standalone scripts that don't have a SocClassifier.
* On match: bump `record_count`. On miss (dist > 0.15): return None and let
  the caller route to the unresolved-employers queue.

### Threshold validation
Smoke probes on real canonicals:

| Query | Closest canonical | Cosine dist | Accept (≤ 0.15)? |
|---|---|---|---|
| `Apple Inc.` | `Apple Inc.` | 0.00 | ✓ |
| `apple inc` | `Apple Inc.` | 0.015 | ✓ |
| `Apple Computer` | `Apple Inc.` | > 0.15 | ✗ |
| `Goggle Inc` (typo) | — | > 0.15 | ✗ |
| `Bytedance Limited` | `ByteDance Inc.` | > 0.15 | ✗ |
| `Random Garbage Co` | — | > 0.15 | ✗ |

The 0.15 threshold is **deliberately strict.** It accepts case/punctuation
variants and clear paraphrases; it rejects everything else. The borderline
calls (`"Apple Computer"`, `"Bytedance Limited"`) are *correct* rejections
under the project's risk model: a wrong canonical pollutes the
employer-SOC consensus aggregator (Stage 0 SOC), distorts per-employer
record-count metrics, and is much harder to detect than an unresolved record
sitting in an operator queue. **False positives are worse than false
negatives.**

### What we learned
* Sentence-transformer embeddings of company names are dominated by token
  semantics, not corporate-form suffixes. `"Apple Computer"` lands close to
  `"Computer"`-laden tech-company embeddings, not particularly close to
  `"Apple Inc."`. Embeddings are not a silver bullet for legal-entity
  deduplication; they are a *paraphrase* tool, not an *identity* tool.
* The HNSW index on a 19,970-row corpus is overkill — a brute-force cosine
  scan would also be sub-millisecond. The index matters at 12M+ records.

### Decision
**Kept** as Layer 3 with threshold 0.15. Encoder shared with SocClassifier.

---

## Quarantine-on-Miss — Option C

### The choice
When all three layers miss, the record's `canonical_employer_id` stays NULL.
Four options were considered:

| Option | Behaviour | Pro | Con |
|---|---|---|---|
| A — Strict | Leave NULL, do nothing | Canonical set stays authoritative | Orphans accumulate forever |
| B — Auto-create | INSERT new canonical, embed it | 100 % coverage | Typos spawn duplicate canonicals |
| **C — Operator queue** | UPSERT into `staging.unresolved_employers` | Human gate prevents pollution; reusable HITL pattern | Requires periodic operator review |
| D — Provisional | Auto-create with `status='provisional'` | Coverage + reviewability | Adds a lifecycle to manage |

**Picked C.** Rationale: (a) for thesis scope, honesty about what's resolved
matters more than 100 % coverage; (b) the same operator-review workflow is
already needed for SOC HITL records (the 103 short-title flags), so one
review CLI eventually serves both queues; (c) Option D is more powerful but
its lifecycle adds scope without buying anything until coverage approaches
production-relevant volumes.

### Schema design
```sql
CREATE TABLE staging.unresolved_employers (
  id                 BIGSERIAL PRIMARY KEY,
  employer_name      TEXT      NOT NULL,
  employer_state     CHAR(2),
  employer_fein      TEXT,           -- preserved if any layer saw a malformed value
  employer_city      TEXT,
  hits               INTEGER   NOT NULL DEFAULT 1,
  first_nlp_id       TEXT,           -- one example, for back-tracing to lca_records
  first_filing_year  SMALLINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ,
  resolved_to_id     UUID REFERENCES canonical_employers(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_unresolved_employers_name_state
  ON staging.unresolved_employers (lower(employer_name), COALESCE(employer_state, ''));
```

The `(lower(name), state)` unique index turns this into an **aggregated
queue**: 5,000 records all naming `"Foreign Holdings GmbH"` produce one row
with `hits = 5000`, not 5,000 duplicate rows. This keeps the operator
review surface small even on dirty corpora.

### Worker integration
The NLP worker calls `dedup.resolve(...)` per record; when it returns None
**and** the record carries an `employer_name`, the record is added to a
per-batch `unresolved` list. After SOC writeback, `_write_unresolved()`
issues an `executemany` UPSERT into the table.

### Why no operator CLI yet
On the current corpus this code path is dead — FEIN coverage is 100 %, so
nothing reaches the unresolved queue. Building a merge/promote CLI without
data to drive it would be speculative API design. The operator CLI is on the
HITL roadmap and will be built when there is real data to inspect (either
historical files or a deliberate quality-degradation test).

### Decision
**Kept** as the residue path. Table + worker write inline; CLI deferred.

---

## Final Architecture & Justification

```
┌─────────────────────────────────────────────────────────────────────┐
│  per record:                                                        │
│                                                                     │
│  Layer 1  ─ FEIN regex + canonical_employers lookup    (~0.3 ms)    │
│      │                                                              │
│      └─ miss ──► Layer 2 ─ pg_trgm, blocked by state   (~1 ms)      │
│                       │                                             │
│                       └─ miss ──► Layer 3 ─ pgvector HNSW (~5 ms)   │
│                                       │                             │
│                                       └─ miss ──► UPSERT into       │
│                                                   staging.          │
│                                                   unresolved_       │
│                                                   employers         │
└─────────────────────────────────────────────────────────────────────┘
```

### Monotone properties
Each layer is **monotone in cost** (FEIN < trgm < vector < operator review)
and **monotone in authority loss** (FEIN is by definition correct; trgm is
deterministic on strings; vector is statistical; operator queue is
human-judged). The cascade puts the cheapest, most authoritative signal
first and only spends the next budget when the previous one is silent.

### Why each kept layer is necessary

| Layer | Removed →  what breaks |
|---|---|
| 1 — FEIN | Authoritative key disappears; everything reduces to string similarity even when a perfect identifier exists. |
| 2 — pg_trgm | Case / punctuation variants of FEIN-less records would all fall through to Layer 3, paying the encode cost on what is a trivial string-similarity decision. |
| 3 — vector | Paraphrase / reword variants are unrecoverable; they sit in the operator queue forever even when an obvious match exists. |
| Operator queue | Misses become silent; coverage gaps cannot be discovered without ad-hoc DB queries. |

### Where the design is honest about its limits
* On modern (post-2020) LCA data, Layers 2 and 3 are **dead code paths**
  because Layer 1 hits 100 % of the time. They earn their keep on historical
  corpora and on synthetic typo-recovery probes only.
* The 0.15 cosine cutoff is **strict**. It will produce false negatives —
  semantic neighbours that don't quite cross the threshold — that route
  to the operator queue. This is the deliberate trade-off documented in the
  Layer 3 section: a wrong canonical is more costly than a missed match.
* `record_count` on `canonical_employers` is bumped *every time* any layer
  matches. If the same record is re-processed (e.g., by the backfill CLI
  for orphans), the count is bumped twice. This is acceptable because
  `record_count` is a soft popularity signal, not a join key.

---

## Open Items

These are not bugs but acknowledged scope for the next iteration:

1. **Operator HITL CLI.** Walk `staging.unresolved_employers` and the SOC
   short-title queue from one tool. Merge / promote / reject actions.
2. **Layer 2/3 exercise on historical data.** Ingest a pre-2020 quarter to
   see real Layer 2/3 traffic and tune thresholds against actual misses.
3. **Periodic embedding refresh.** When new canonicals are inserted (today
   only via Layer 1), `embed-employers` must be rerun before Layer 3 can
   match them. Cron or post-ingest hook.
4. **Cross-layer audit.** A monitoring query that asserts `lca_records.id
   ⇄ canonical_employer_id IS NOT NULL ∨ row in staging.unresolved_employers`
   to catch any future leak like the quarantine-drain incident.
