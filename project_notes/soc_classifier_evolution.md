# SOC Classifier Evolution

> A chronological account of the SOC classification pipeline as it evolved from
> a single dictionary lookup to a four-stage hybrid system.
>
> Each section documents:
> 1. **What was tried** — the concrete approach
> 2. **Why** — the hypothesis or constraint that motivated it
> 3. **How it was implemented** — code path / data structures
> 4. **Results** — measured outcomes on the FY2025 Q1 corpus (107,414 records)
> 5. **What we learned** — interpretation, including any surprises
> 6. **Decision** — kept, iterated, or rejected
>
> The final design is justified by what each rejected alternative failed at and
> what each kept stage uniquely contributes.

---

## Table of Contents

1. [Stage 1 — DMTF Exact Match (baseline)](#stage-1--dmtf-exact-match-baseline)
2. [Stage 2 — Sentence-Transformer Semantic Retrieval](#stage-2--sentence-transformer-semantic-retrieval)
3. [Cross-Employer Alias Bootstrap](#cross-employer-alias-bootstrap)
4. [Rejected Path — Fine-Tuned BERT Classifier](#rejected-path--fine-tuned-bert-classifier)
5. [Stage 3 — LLM-on-Residual](#stage-3--llm-on-residual)
6. [Short-Title HITL Gate](#short-title-hitl-gate)
7. [Stage 0 — Per-Employer SOC Consensus](#stage-0--per-employer-soc-consensus)
8. [Final Architecture & Justification](#final-architecture--justification)

---

## Stage 1 — DMTF Exact Match (baseline)

### What was tried
A single case-insensitive lookup against the **BLS Direct Match Title File**
(DMTF) — the U.S. Bureau of Labor Statistics' authoritative dictionary mapping
plain-English job titles to SOC (Standard Occupational Classification) codes.

### Why
Before any ML, we needed a deterministic, defensible baseline. DMTF is:

* **Authoritative** — it is the official BLS reference. A match is by
  definition correct.
* **Cheap** — a single B-tree index lookup per record, no model required.
* **Interpretable** — every assignment is traceable to a specific dictionary
  row, which matters for HITL review and audit.

### How it was implemented
* Loader: `dmtf_loader.py` — downloads the latest BLS DMTF spreadsheet,
  auto-detects column layouts, and bulk-upserts ~6,500 (title, SOC) pairs into
  the `soc_aliases` table with `source='dmtf'`.
* A unique B-tree index on `lower(soc_aliases.job_title)` makes case-insensitive
  exact matching ~0.5 ms per lookup.
* `SocClassifier._lookup_dmtf()` returns a `SocPrediction` with confidence 1.0
  on hit, `None` on miss.

### Results on FY2025 Q1 (107,414 records)

| Metric | Value |
|---|---|
| DMTF coverage | ~58% of records hit exactly |
| Confidence on hit | 1.0 (by construction) |
| Latency | ~0.5 ms / record |

### What we learned
* DMTF is necessary but insufficient. Real LCA filings carry employer-mangled
  titles ("Sr. Software Eng III", "SWE", "Mgr - Computer Sys Eng/Architect")
  that the BLS dictionary does not anticipate. Roughly 40% of titles miss.
* Coverage scales sub-linearly with corpus growth — every new corner of the
  labour market (cell-and-gene therapy roles, gen-AI titles, niche fintech)
  introduces new misses faster than DMTF can be updated.

### Decision
**Kept** as Stage 1. It remains the most reliable signal we have when it fires.
But a fallback for the 40% of misses became the next required step.

---

## Stage 2 — Sentence-Transformer Semantic Retrieval

### What was tried
For every Stage-1 miss, embed the input title and the entire `soc_aliases`
corpus with a **sentence-transformer** (`all-MiniLM-L6-v2`, 384-dim), then
return the nearest-neighbour SOC by cosine similarity.

### Why
We considered three alternatives before picking semantic retrieval:

| Option | Rejected because |
|---|---|
| Levenshtein / fuzzy string matching | Catches typos but not paraphrases ("SWE" vs "Software Engineer") |
| TF-IDF + cosine | Stronger than fuzzy, but treats words as orthogonal — misses synonyms ("Engineer" ≠ "Developer") |
| Zero-shot NLI classifier (e.g. `bart-large-mnli`) | ~1000× slower than retrieval; one forward pass *per candidate label* per record. On 6500 labels × 107K records = infeasible on CPU |

Semantic retrieval gives us paraphrase-aware matching (encoder learned during
pre-training) at the cost of just **one** forward pass per record, plus a
single dot-product against a precomputed alias matrix.

### How it was implemented
* `SocClassifier._load_stage2()` — at startup, load the encoder and embed all
  ~6500 aliases once into a normalized `(N, 384)` tensor cached in memory.
* Per record: encode → dot product against alias matrix → `argmax`.
* If the cosine similarity is below `NLP_STAGE2_THRESHOLD` (default 0.7) the
  record is still returned but with `requires_review=True` and routed to
  `staging.quarantine_records`.

### Results on FY2025 Q1 (Stage-1 misses only — about 43K records)

| Confidence band | Records | Notes |
|---|---|---|
| ≥ 0.90 | 15,759 | Near-paraphrases of DMTF entries |
| 0.80 – 0.89 | 15,781 | Strong matches |
| 0.70 – 0.79 | 6,978 | Acceptable — at the threshold |
| < 0.70 (quarantined) | ~4K | Routed to HITL queue |

End-to-end Stage 1 + Stage 2 coverage: **96.2%** at confidence ≥ 0.7.

### What we learned
* Retrieval inherits the breadth of the encoder's pre-training. It generalises
  to titles never seen by BLS without any further training data.
* The threshold of 0.7 is a deliberately conservative gate. Records that fall
  below it are *not* discarded — they accumulate in quarantine for the next
  stage to address.
* The single biggest weakness: retrieval picks the *nearest* alias, not the
  *correct* SOC. When the alias corpus is missing the right answer entirely,
  retrieval returns a nearby-but-wrong code with high confidence.

### Decision
**Kept** as Stage 2. The 4% residue motivated the next two improvements
(bootstrap + LLM).

---

## Cross-Employer Alias Bootstrap

### What was tried
A **self-supervised** alias mining step: scan `lca_records` for
`(JOB_TITLE, SOC_CODE)` pairs where many independent employers all use the
same SOC for the same title, and admit those pairs into `soc_aliases` so both
Stage 1 and Stage 2 immediately gain coverage.

### Why
Stage 2 quality is a direct function of the alias corpus. The DMTF gives us
6,500 anchors. But our own historical filings already contain millions of
employer-supplied (title, SOC) pairs. Most of them are noisy — individual
employers misfile — but **cross-employer agreement** is a strong denoising
signal: if 50 different companies all label "Solutions Architect" as 15-1299,
that consensus is at least as reliable as the DMTF.

This is essentially **distant supervision**: use the data itself to teach the
encoder which titles map to which SOCs without any hand labelling.

### How it was implemented
* `alias_bootstrap.py` runs a CTE that aggregates per `(title_norm, soc_code)`:
  * `hits ≥ 5` (rare pairs are noise)
  * `distinct_employers ≥ 2` (one big filer can't dominate)
  * `(hits / total_for_title) ≥ 0.8` (strong cross-employer agreement)
* Surviving rows are inserted with `source='lca_bootstrap'` (unique index on
  `lower(job_title)` keeps DMTF rows authoritative).
* The classifier is restarted to pick up the expanded corpus and rebuild
  Stage 2 embeddings.

### Results
* Aliases grew from ~6,500 (DMTF) to **13,003** (DMTF + 6,483 bootstrapped).
* Quarantine on the FY2025 Q1 sample dropped by **~91%** vs. DMTF-only.
* Stage 1 hit rate jumped from ~58% to ~60% (small) but Stage 2's *quality*
  improved much more — many records that previously sat at 0.7–0.8 confidence
  now hit DMTF/alias exactly with confidence 1.0.

### What we learned
* Bootstrap is the highest-ROI step we took. Free supervision, no training,
  and it tightens both stages downstream.
* The agreement filter (≥0.8) is critical. Without it, the aliases reflect
  whatever the most common (i.e. most prolific) filer uses, regardless of
  whether that's correct.

### Decision
**Kept**. It runs after every harvest as `pnpm aliases:bootstrap`.

---

## Rejected Path — Fine-Tuned BERT Classifier

### What was tried
A multi-class classifier head fine-tuned on the bootstrap-derived (title, SOC)
pairs. The architecture: `bert-base-uncased` + linear head over the 332 SOC
classes that appear in the data, trained with cross-entropy on
80% of the consensus pairs (~49K examples), evaluated on the held-out 20%
(~11K) with FEIN-disjoint train/test splits.

### Why
The dominant assumption in NLP literature is that fine-tuning beats retrieval
once you have any labelled data. Two arguments specifically motivated trying:

1. **Sub-code discrimination**: Stage 2 retrieval often picks the right
   *major group* (15-1xxx Computer occupations) but the wrong sub-code
   (15-1252 Software Developers vs 15-1251 Computer Programmers vs 15-1299
   Computer Systems Engineers). A supervised classifier might learn the
   distinctions that matter at sub-code resolution.
2. **Thesis value**: A fine-tuning chapter is a clean ML-pipeline narrative
   regardless of outcome.

A go/no-go decision rule was set in advance:

> If fine-tuned BERT achieves **≥ 60% exact match** on the held-out set,
> commit and integrate as Stage 3. Below that, pivot.

### How it was implemented
* `experiments/train_viability.py` — held-out 20% by `EMPLOYER_FEIN` to keep
  train and test disjoint at the employer level (so we measure generalisation,
  not memorisation).
* MPS backend on M1 Pro, batch size 32, 2 epochs, learning rate 2e-5.
* Stage 2 baseline measured on the *same* held-out titles for direct
  comparison.

### Results (held-out 11,090 titles)

| Approach | Exact match | Major group |
|---|---|---|
| Stage 2 retrieval (baseline) | **72.9%** | **89.2%** |
| Fine-tuned BERT (2 epochs) | 61.9% | 86.0% |
| Δ | **−11.0 pp** | −3.2 pp |

Training was healthy (loss 5.33 → 1.40 over 2 epochs, no instability or
overfit). The model learned. It just learned worse than retrieval.

### What we learned

This is the most interesting finding of the project. Three structural reasons
explain why fine-tuning lost:

1. **Label noise dominates with 332 classes.** Employer-supplied SOC codes are
   noisy (a calibration table from earlier shows employers heavily over-use
   catch-all 15-1299). Cross-entropy training treats each label as ground
   truth; retrieval doesn't — it sidesteps the issue by computing
   title-to-title similarity rather than learning class boundaries.
2. **Retrieval gets bootstrap-aliases for free.** The alias corpus already
   embeds cross-employer consensus — i.e. denoised supervision. BERT trained
   on raw per-record labels never sees that denoising directly.
3. **332 classes ÷ 49K examples ≈ 150 examples / class average**, much fewer
   for tail SOC codes. Retrieval has no per-class data-hunger problem; every
   alias is one more anchor in embedding space, regardless of class size.

### Decision
**Rejected.** Per the pre-set decision rule, BERT did not clear the bar. The
result is included in the thesis as a **publishable negative finding**:
*retrieval + self-supervised alias bootstrapping beats supervised fine-tuning
on noisy multi-class taxonomies at this scale.*

---

## Stage 3 — LLM-on-Residual

### What was tried
For every record below the Stage 2 confidence threshold (0.7), retrieve the
top-K (=10) Stage 2 candidates and ask a **local LLM** (Llama 3.1 8B via
Ollama) to pick the best one from that short list.

### Why
After bootstrap + Stage 2, the residual quarantine was ~4,000 records — long-tail
titles that retrieval could not confidently disambiguate. Two reasons LLM:

* **Targeted use, not whole-corpus**: running an LLM on all 107K records would
  be prohibitively slow (~3 s/record on M1 Pro = days). Running it on the 4K
  residue is ~3.5 hours and addresses exactly the cohort that needs help.
* **Constrained generation**: the LLM is *not* asked to produce a SOC code
  from scratch (it would hallucinate). It only chooses from a pre-retrieved
  short list, which combines retrieval recall with LLM discrimination on
  close-neighbour distinctions.

Two backends are pluggable: `OllamaBackend` (free, reproducible) and
`AnthropicBackend` (faster, paid). The thesis defaults to Ollama for
reproducibility.

### How it was implemented
* `llm_classifier.py` — `LlmClassifier` with backend abstraction (`Protocol`).
  Strict JSON output (`{"choice": int, "confident": bool, "reason": str}`),
  parsed defensively (regex fallback if Llama wraps JSON in prose).
* `reclassify_quarantine.py` — drains `staging.quarantine_records` in batches
  with **keyset pagination** (initially had an off-by-batch bug with `OFFSET`
  + concurrent deletes, which silently truncated the run at exactly 50% — see
  fix in commit history; now safe).
* The CLI uses `--top-k 10 --batch 200` for throughput, but writes one record
  at a time to keep transactions small.

### Results

Two runs combined drained 4,048 records (the bug-fixed second run picked up
the 2,000 that the first iteration missed):

| Metric | Run 1 | Run 2 | Total |
|---|---:|---:|---:|
| Records seen | 2,048 | 2,000 | 4,048 |
| Confident picks | 2,047 (100%) | 1,995 (99.8%) | 4,042 |
| LLM-refused | 1 | 5 | 6 |
| Errors | 0 | 0 | 0 |
| Wall time | 1h 45m | 1h 43m | 3h 28m |

Sample quality (random 20-record audit):

* ~14/20 clearly correct
* ~4/20 defensible
* ~2/20 wrong, all on uninformative or jargon titles

Distribution health: **332 distinct SOC codes used**, top code only 9.18% —
no taxonomic collapse. The LLM is genuinely discriminating, not defaulting.

Quarantine drained **from ~4,000 to 5** (0.005% of the original input).

### What we learned
* LLM-on-residual is the right hammer for the long tail. It's expensive
  per-record (3.5 s) but cheap *in aggregate* because the residue is small.
* Free local inference (Ollama) is competitive enough on this task that we
  did not need an API budget.
* **Failure mode**: literal-string interpretation of short or jargon titles.
  "Cellar Lead" → Industrial Engineer. "Structurer" → Structural Iron Worker.
  "Investigations Producer" → Detective. These need a separate guard. (See
  next section.)

### Decision
**Kept** as Stage 3. Re-run as `pnpm quarantine:reclassify` after every
harvest.

---

## Short-Title HITL Gate

### What was tried
A simple length-based downgrade inside `LlmClassifier.classify`: if the input
title is shorter than 12 characters AND the LLM was confident, force the
result to `requires_review=true` so it lands in a HITL queue rather than
being silently committed.

### Why
The LLM's failure mode on Stage 3 was concentrated on short or jargon-heavy
titles. Examples (real picks the LLM made confidently):

* "Partner" → Lawyers (defensible at a law firm; wrong everywhere else)
* "Fellow" → Lawyers (academic / medical / legal ambiguity)
* "Cellar Lead" → Industrial Engineer (winemaking misread as manufacturing)
* "Structurer" → Structural Iron Worker (derivatives finance misread as steel)
* "Investigations Producer" → Detective (TV journalism misread as law enforcement)

These all share a property: the title has too few tokens for the LLM to
disambiguate from a Stage 2 candidate list. A heuristic gate is far cheaper
than a stronger model and addresses the failure exactly where it happens.

### How it was implemented
* Constant `SHORT_TITLE_THRESHOLD` (default 12, env-overridable via
  `LLM_SHORT_TITLE_THRESHOLD`).
* Inside `LlmClassifier.classify`, after parsing the LLM's decision: if the
  title is short and the LLM was confident, replace `confident=True` with
  `confident=False` and add `review_reason='short_title_llm_pick'`.
* `reclassify_quarantine.py` distinguishes the two "not confident" cases:
  genuine LLM refusal (leave in quarantine) vs gate-downgraded confident pick
  (write to `lca_records` with `requires_review=true`).

### Results
On the existing 4,042 LLM-reclassified records, applying the gate flagged
**111 rows** (2.7%) as `requires_review`. This is the elevated-risk cohort
documented as the HITL backlog.

### What we learned
* Heuristics that target a **known failure mode** are usually better than
  generic guards (e.g. higher confidence thresholds). The 12-char threshold
  catches exactly the cases that fail without penalising long titles that the
  LLM handles well.
* **Downgrading rather than rejecting** preserves the LLM's pick — it's still
  almost always better than nothing — while routing the record for human
  audit. This is a more useful behaviour than throwing the work away.

### Decision
**Kept**. Runs automatically inside `LlmClassifier.classify` so any future
quarantine drain inherits the gate without further action.

---

## Stage 0 — Per-Employer SOC Consensus

### What was tried
A new pre-pipeline lookup: for each incoming record, consult an
`employer_soc_consensus` table keyed on `(FEIN, normalized_title) → SOC`
that is rebuilt periodically from `lca_records`. If the employer has filed
the same job title at least 5 times with at least 80% SOC agreement, that
consensus wins **before** Stage 1, Stage 2, or Stage 3 even runs.

### Why
After observing the LLM's "Partner" → Lawyers picks, an obvious gap emerged:
the employer themselves is the authority on what a job at their company is.

* "Partner" at a law firm filed by the law firm 50 times, all labelled
  23-1011 → that's authoritative.
* "Software Engineer" at Goldman Sachs filed as 13-2099 (Financial
  Quantitative Analyst) — different from the broad-industry default — should
  win for Goldman filings even if the global consensus is 15-1252.

`alias_bootstrap` already mines **cross-employer** consensus into
`soc_aliases`. That captures global agreement. Stage 0 captures
**per-employer** agreement, which is *additive* — it solves cases the global
signal cannot resolve.

This also subsumes a one-shot post-processing script that would have
overridden specific records — by promoting it to a worker stage, every future
ingestion benefits automatically.

### How it was implemented
* New table `employer_soc_consensus(fein, job_title_norm, soc_code, soc_title,
  hits, agreement, refreshed_at)` with PK `(fein, job_title_norm)`.
* `employer_consensus.py` — `refresh-employer-consensus` CLI rebuilds the
  table from a CTE that aggregates `lca_records` per `(FEIN, title_norm,
  SOC)` with the same `min_hits / min_agreement` discipline as alias_bootstrap.
* `SocClassifier._lookup_employer_consensus(title, fein)` — per-record DB
  lookup mirroring `_lookup_dmtf`, returns confidence = `min(0.99, agreement)`
  so DMTF stays the only 1.0-confidence source.
* `predict()` and `predict_batch()` now accept FEIN and consult Stage 0
  before Stage 1.
* `worker.py` passes FEINs through.

### Results

* On the FY2025 Q1 corpus, **1,597 (FEIN, title) → SOC consensus entries** at
  `min_hits=5 / min_agreement=0.8`.
* Backfill: re-running Stage 0 against the 4,042 existing LLM-reclassified
  records identified **8 records** where Stage 0 has authoritative consensus.
  All 8 are "Partner" filings by the same law firm — the LLM had guessed each
  of them, the consensus correctly resolved them to **23-1011 Lawyers**.

This is the single cleanest validation of the Stage 0 design: it caught
exactly the failure mode the short-title gate was protecting against, and
produced an authoritative answer rather than a HITL flag.

### What we learned
* The right *unit of authority* matters. Cross-employer consensus is great
  for unambiguous titles; per-employer consensus is essential for ambiguous
  ones whose meaning depends on the filer.
* The two consensus mechanisms compose without conflict. Stage 0 (per-employer)
  fires first; if it doesn't, Stage 1 (which includes cross-employer
  bootstrap) is the fallback; if neither fires, retrieval and LLM follow.
* Promoting an idea from a one-shot script to a worker stage is the
  difference between "works once" and "works forever". This is the
  architectural lesson that closes the loop.

### Decision
**Kept** as Stage 0. Refreshed via `pnpm consensus:refresh` after every
harvest.

---

## Final Architecture & Justification

### Pipeline order

```
record (title, FEIN)
  │
  ▼
Stage 0 — employer_soc_consensus lookup     [confidence ≤ 0.99, source='employer_consensus']
  │  (miss)
  ▼
Stage 1 — soc_aliases exact match (DMTF + bootstrap)   [confidence = 1.0, source='dmtf']
  │  (miss)
  ▼
Stage 2 — sentence-transformer retrieval     [confidence = cosine, source='stage2']
  │  (confidence < 0.7) → quarantine
  ▼
Stage 3 — LLM picks from top-10 Stage 2 candidates    [source='llm']
  │  (confident & title >= 12 chars)        → write back
  │  (confident & title < 12 chars)         → write back, requires_review=true
  │  (LLM refused)                          → leave in quarantine
```

### Why this order

| Stage | Authority | Cost | Coverage |
|---|---|---|---|
| 0. Employer consensus | Employer self-consistency over many filings | DB index lookup (~0.5 ms) | Targeted |
| 1. DMTF / bootstrap exact match | BLS dictionary + cross-employer consensus | DB index lookup (~0.5 ms) | ~60% |
| 2. Semantic retrieval | Sentence-transformer pretraining | One forward pass + dot product (~10 ms) | ~36% (cumulative ~96%) |
| 3. LLM-on-residual | LLM selecting from a constrained candidate set | ~3.5 s / record (Ollama) | ~3.7% (cumulative ~99.99%) |

The order is **monotone in cost and inverse-monotone in authority**. Each
later stage is more expensive per record but applies to a smaller and more
ambiguous cohort. This is the structural reason the pipeline scales: 99% of
records are handled in milliseconds; the seconds-per-record stage runs only
on the ~4% that need it.

### Final coverage on FY2025 Q1 (107,414 records)

| Bucket | Count | % |
|---|---:|---:|
| Confidently classified | 107,301 | 99.89% |
| Flagged HITL (short-title) | 103 | 0.10% |
| Quarantine residue (LLM-refused) | 5 | 0.005% |
| Stage 0 overrides (vs LLM picks) | 8 | (subset) |

### Why each rejected option was rejected

| Option | Rejection reason |
|---|---|
| Levenshtein / fuzzy | Catches typos, not paraphrases. Insufficient for free-text job titles. |
| TF-IDF | Treats words as orthogonal — misses synonyms. |
| Zero-shot NLI | ~1000× slower than retrieval; infeasible at 107K records on CPU. |
| Tightening Stage 2 threshold to 0.85 | Improves precision on kept records but balloons quarantine. Doesn't fix the underlying problem. |
| Stronger encoder (mpnet, bge-large) | 5× slower, marginal gain (~3–8pp on hard cases). Same architecture, no SOC-specific signal. |
| Cross-encoder reranking | Reasonable secondary path but BERT/LLM dominate it on the metrics. |
| Fine-tuned BERT classifier | Empirically lost to retrieval by 11pp exact (see dedicated section). Documented as a thesis finding. |
| API LLM (Claude/GPT) on full corpus | $50–200/pass; not reproducible without API access; thesis loses portability. |
| Auto-scheduling reclassify-quarantine in BullMQ | Adds infra complexity for limited current benefit; manual run after harvest is sufficient. |

### Why each kept stage is necessary

* **Stage 0** is the only stage that uses the *employer's own self-consistency*
  as evidence. Without it, "Partner" at a law firm gets generic LLM treatment.
* **Stage 1** is the only deterministic, fully-authoritative source. Without
  it, even unambiguous BLS titles would go through the encoder pointlessly.
* **Stage 2** is the only stage that generalises beyond the labelled corpus.
  Without it, every novel-but-unambiguous title would fall to the LLM.
* **Stage 3** is the only stage that can reason about long-tail titles whose
  exact match isn't in the corpus and whose embedding similarity is borderline.
  Without it, ~4% of records would sit in quarantine indefinitely.

Removing any one stage would either degrade quality or shift work onto a
much more expensive stage.

### Operational runbook (after every harvest)

1. The worker auto-runs Stage 0 → 1 → 2 inline (no action required).
2. `pnpm consensus:refresh` — rebuild the per-employer lookup from
   newly-ingested rows.
3. `pnpm aliases:bootstrap` — same for cross-employer consensus.
4. `pnpm quarantine:reclassify` — drain the residual quarantine via Stage 3,
   with the short-title gate firing automatically.

### What this pipeline is *not*

* It is not a final-form production system. The 5 quarantine residue records
  and 103 HITL flags need a review interface (deferred — design only).
* It does not rely on any external API by default. (Anthropic backend
  remains pluggable for users who prefer it.)
* It does not claim to be optimal for *all* taxonomic classification problems.
  The conclusions about retrieval-vs-fine-tuning are specific to noisy
  multi-class taxonomies of this scale (~300 classes, ~50K labels).

---

*Last updated: 2026-05-04*
