# operator-ui

Web UI for the human-in-the-loop (HITL) operator. Walks the three review queues
that the automated pipeline cannot resolve on its own and writes the operator's
decision back to PostgreSQL.

- Built on Fastify with server-rendered EJS views — no JS build step.
- Reuses `@lca/db-lib` for the connection pool.
- Ships as Docker Compose service `operator-ui` on **port 8080**.
- Single shared password (`OPERATOR_PASSWORD`), signed-cookie session.

---

## Table of contents

1. [First time? Read this](#first-time-read-this)
2. [Setup](#setup)
3. [The dashboard](#the-dashboard)
4. [Queue 1 — Reviews](#queue-1--reviews)
5. [Queue 2 — Quarantine](#queue-2--quarantine)
6. [Queue 3 — Unresolved employers](#queue-3--unresolved-employers)
7. [Cheat sheet — common decisions](#cheat-sheet--common-decisions)
8. [Reference — routes & write-back semantics](#reference--routes--write-back-semantics)

---

## First time? Read this

The pipeline tries to classify every LCA record automatically. Three things
can go wrong:

| Failure | Where it shows up | What the operator does |
|---|---|---|
| The automated SOC classification looks suspicious | **Reviews** queue | Accept it / override it / kick to quarantine |
| The automated classifier *refused* to pick anything | **Quarantine** queue | Assign a SOC by hand / drop |
| The employer-deduplication layers couldn't match a known company | **Unresolved** queue | Merge into a known canonical / create a new one |

You'll spend ~80 % of your time in the **Unresolved** queue — it's the most
data-rich and the most rewarding (one merge backfills hundreds of LCA rows
at once). Reviews is usually the smallest queue. Quarantine is the
biggest but the slowest-moving — typically waits for a Stage 3 LLM run on
GPU rather than per-record operator action.

**Golden rule:** every action is a *transactional write*. Once you click,
the database is updated and the next NLP run won't re-flag the record.
Take a moment before each click.

---

## Setup

### Required environment variables

| Variable | Required | Description |
|---|---|---|
| `OPERATOR_PASSWORD` | yes | Shared operator password. Anything non-empty. |
| `SESSION_SECRET` | yes | HMAC key for cookie signing. **≥ 32 characters.** Generate with `openssl rand -hex 32`. |
| `DATABASE_URL` | yes | Same connection string as the rest of the stack. |
| `OPERATOR_UI_PORT` | no | Host port (default `8080`). |
| `OPERATOR_UI_HOST` | no | Bind address (default `0.0.0.0`). |

Put these in the root `.env` file.

### Bring it up

```bash
# Docker (default for the full stack)
docker compose up -d operator-ui
open http://localhost:8080

# OR host iteration with hot reload
pnpm operator:dev
```

Health probe (no auth):
```bash
curl -s http://localhost:8080/healthz   # {"ok":true}
```

### Log in

The first page you'll see is the login form. Type the `OPERATOR_PASSWORD`
and submit. The server sets a signed cookie `operator_sid`; every page
after that is authenticated. Log out via the button in the top-right of
the header.

---

## The dashboard

`GET /` — the landing page after login. Shows three cards, one per queue,
each with a live count of pending records.

```
┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
│  Reviews                │  │  Quarantine             │  │  Unresolved employers   │
│                         │  │                         │  │                         │
│           0             │  │       181,839           │  │           0             │
│                         │  │                         │  │                         │
│  Records flagged        │  │  LLM-refused residue.   │  │  No layer matched.      │
│  requires_review=true   │  │  Manual SOC or drop.    │  │  Merge or create new.   │
└─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
```

Pick a queue. The number on the card is the open count.

---

## Queue 1 — Reviews

**URL:** `/reviews` · **Records source:** `lca_records` rows where `data->>'requires_review' = 'true'` · **Typical depth:** very small after a good NLP run.

### What's in this queue

These are records that the automated classifier *did* pick a SOC for, but
the pipeline flagged the pick as suspicious. The two common reasons:

| `review_reason` | Why it was flagged |
|---|---|
| `short_title_gate` | The Stage 3 LLM was asked to pick a SOC for a job title that's almost certainly a literal name or marketing string (e.g. `"Engineer"`, `"SWE 4"`, `"Founding Eng"`). The LLM picked something, but the short-title gate considers it too risky to trust automatically. |
| `low_confidence` | The Stage 2 semantic classifier picked the best match it could, but the cosine similarity is below the 0.7 trust threshold. |
| Other | Anything routed here by the worker's `requires_review` logic — see `data->>'review_reason'` on the row. |

### Walking the queue

1. Click the **Reviews** card on the dashboard, or `Reviews` in the top nav.
2. You'll see a paginated table. Columns:

   | Column | What it means |
   |---|---|
   | Year | Filing year (the partition key). |
   | Job title | The raw `JOB_TITLE` from the DOL filing — verbatim, no normalisation. |
   | Employer | The raw `EMPLOYER_NAME`. |
   | State | The 2-letter employer state. |
   | SOC | The SOC code the classifier *currently* believes. |
   | Conf. | Stage 2 cosine confidence (0–1). Blank if the pick came from a different stage. |
   | Source | Which stage made the pick (`dmtf`, `stage2`, `employer_consensus`, `llm`, `operator`). |
   | Reason | The `review_reason` code. |

3. Click **Inspect →** on the row you want to handle.

### Inspecting a record

The inspect page shows the full key fields, the current SOC pick, the
confidence and source, and the raw JSONB at the bottom (collapsed by
default — click "Full record (JSONB)" to expand).

You have **three actions** — pick one:

| Action | When to use | What it does |
|---|---|---|
| **Accept** | The current SOC pick is correct. Click and move on. | Patches `lca_records`: sets `requires_review=false`, `review_reason=null`, `operator_action='accepted'`. Disabled if there's no SOC at all. |
| **Override** | The current SOC pick is wrong but you know the correct one. Type the new SOC code (and optionally the title) and submit. | Patches `lca_records` with the new SOC, `soc_source='operator'`, `soc_confidence=1.0`, clears the review flag. Look up the BLS SOC code list ([https://www.bls.gov/soc/](https://www.bls.gov/soc/)) if you need to find one. |
| **Reject to quarantine** | The job title is genuinely ambiguous or unparseable. | Clears the SOC fields on `lca_records` and inserts a fresh row into `staging.quarantine_records` with `errors.type='operator_rejected_review'`. The record can then be handled later via the quarantine queue (e.g. by Stage 3 LLM). |

### Decision shortcuts

- **Confident the existing SOC is right** → Accept.
- **Wrong, and you know the right SOC** → Override.
- **You can't tell** → Reject. Don't guess; downstream NLP / LLM can take another pass.

---

## Queue 2 — Quarantine

**URL:** `/quarantine` · **Records source:** `staging.quarantine_records` where `reprocessed_at IS NULL` · **Typical depth:** large (181 K after the 2026 re-ingest).

### What's in this queue

These are records the automated pipeline gave up on. Two main causes:

| `errors.type` | What happened |
|---|---|
| `llm_refused` | Stage 3 LLM was offered a list of candidate SOCs and declined to pick any (returned `"NONE"` or invalid output). |
| `validation_failed` | Zod schema validation rejected the record at ingest time — required field missing, malformed wage, etc. |
| `operator_rejected_review` | An operator-rejected review from Queue 1 landed here. |

Most entries are Stage 3 LLM refusals, which is the expected behaviour for
short titles like `"Engineer"`, `"Consultant"`, `"Manager"` — too generic
for the model to commit. These are the cases where a human really does
add value over the LLM.

### Walking the queue

1. Click **Quarantine** on the dashboard or in the nav.
2. Columns:

   | Column | What it means |
   |---|---|
   | ID | Quarantine row id. |
   | Year | Filing year. |
   | Job title | The original `JOB_TITLE`. |
   | Employer | The original `EMPLOYER_NAME`. |
   | State | 2-letter state. |
   | Error | The `errors.type` value (see table above). |
   | Created | When the row landed in quarantine. |

3. Click **Inspect →**.

### Inspecting a record

The inspect page surfaces:
- The `_nlp_id` (the UUID the NLP worker tagged the original `lca_records` row with — used to find the row when you assign a SOC).
- Job title, employer, state, current SOC (if any), error type.
- Two collapsible blocks at the bottom: raw data (the full payload that went into NLP) and the error JSON.

You have **two actions**:

| Action | When to use | What it does |
|---|---|---|
| **Assign SOC manually** | You can determine a sensible SOC for this record. Type the SOC code and an optional title + note. | Finds the originating `lca_records` row by `data->>'_nlp_id'` + `filing_year`, patches it with the SOC and `soc_source='operator'`. Marks the quarantine row `reprocessed_at = NOW()`. If the originating record can't be found (rare — happens for ancient pre-`_nlp_id` rows), still marks reprocessed but logs `lca_record_updated: false`. |
| **Drop** | The record is unrecoverable — junk title, malformed source data, duplicate of something else. | Only marks `reprocessed_at`. The originating `lca_records` row (if any) is left untouched; `soc_code` stays NULL there. |

### Decision shortcuts

- **You can guess the SOC** (e.g. "Sr Eng" + the employer is a SaaS company → `15-1252`) → Assign.
- **The job title is too generic or garbage** (e.g. `"X"`, `"Worker"`, `"Person"`) → Drop.
- **You're not sure** → Skip it (close the tab). Stage 3 LLM might handle it in the next batch.

### Important note for large queues

At 181 K open records, walking quarantine by hand is not practical. The
recommended workflow is to run **Stage 3 LLM reclassify** on GPU first
(see `quarantine:reclassify` in the root README) and only handle the
residue manually here.

---

## Queue 3 — Unresolved employers

**URL:** `/unresolved` · **Records source:** `staging.unresolved_employers` where `resolved_at IS NULL` · **Typical depth:** 0 after a full-cascade backfill, but accumulates as new ingests land.

### What's in this queue

These are unique `(employer_name, employer_state)` pairs the entity-
resolution cascade could not match to any existing `canonical_employers`
row. The three layers it tried:

1. **Layer 1 — FEIN deterministic match.** Did the record's `EMPLOYER_FEIN`
   already point to a known canonical? Pre-2024 DOL files have 0 % FEIN,
   so this layer is data-dead on those years.
2. **Layer 2 — pg_trgm fuzzy name match.** Trigram similarity score
   against canonicals in the same state, threshold ~0.6.
3. **Layer 3 — pgvector semantic match.** 384-dim sentence-transformer
   cosine, against `employer_embeddings`.

If all three miss, the name+state pair lands here.

### Walking the queue

1. Click **Unresolved employers** on the dashboard or in the nav.
2. The list is sorted by **hits** (how many records share this
   name+state) — high-impact entries first. One merge here can backfill
   thousands of `lca_records` rows in a single transaction.
3. Columns:

   | Column | What it means |
   |---|---|
   | ID | Unresolved row id. |
   | Employer name | The raw name as DOL spelled it. |
   | State | 2-letter state. |
   | FEIN | Employer FEIN if present. |
   | City | Employer city if present. |
   | Hits | How many LCA records share this `(name, state)` pair. **This is the lever — high-hits merges are high-value.** |
   | Last seen | The most recent ingest that bumped this row. |

4. Click **Inspect →**.

### Inspecting a record

This is the most informative inspect page in the UI. You see:

**Top section** — the unresolved entry's raw fields: name, state, FEIN, city, hits, first filing year.

**Middle section — "Similar canonical employers"**. This is the killer
feature: a trigram-similarity search against `canonical_employers`,
filtered to the same state. Up to 20 candidates, ordered by score:

| Column | What it means |
|---|---|
| **Score** | Trigram similarity (0–1). See guidance below. |
| Canonical name | The matched canonical's name. |
| State | The canonical's state. |
| FEIN | The canonical's FEIN if known. |
| Records | How many existing `lca_records` rows already point to this canonical. |
| Merge here | The action button. |

**Score interpretation:**
- **≥ 0.6** — Very likely the same entity. Names usually differ by one or
  two words. Click "Merge here" without hesitation.
- **0.4 – 0.6** — Plausibly the same entity, but inspect the names. A
  match here is often legal-entity variants (`"Google LLC"` vs `"Google
  Inc"`). Use FEIN as a tiebreaker if both have one.
- **< 0.4** — Probably different entities. Be cautious; create a new
  canonical instead.

**Bottom section — three actions:**

| Action | When to use | What it does |
|---|---|---|
| **Merge into candidate row** (button on each similar-canonical row) | The candidate is the same legal entity. | Transactionally: confirms target canonical exists; updates every `lca_records` row where `lower(EMPLOYER_NAME)` matches and (if state known) state matches and `canonical_employer_id` is NULL, setting it to the merged canonical id; bumps the canonical's `record_count`; marks the unresolved row resolved. |
| **Create new canonical** | None of the candidates fit — this is a genuinely new employer in the corpus. | If the unresolved row has a FEIN that's already in `canonical_employers`, prefers that existing canonical (FEIN is unique). Otherwise inserts a fresh `canonical_employers` row from the unresolved fields, then runs the same backfill as merge. |
| **Reject** | Junk / unparseable name (`"-"`, `"COMPANY"`, `"."`). | Marks `resolved_at = NOW()` with `resolved_to_id = NULL`. No `lca_records` backfill — those rows stay without a canonical id. Use sparingly. |

### Decision walkthrough — typical patterns

**Pattern 1 — same legal entity, different spelling.**
- Unresolved: `"GOOGLE LLC."` (CA) — hits 240, FEIN `77-0493581`
- Top candidate: `"Google LLC"` (CA) — FEIN `77-0493581`, score `0.821`
- → Same FEIN, near-identical name. **Merge.**

**Pattern 2 — same trade name, different legal entity.**
- Unresolved: `"AMAZON.COM SERVICES LLC"` (VA) — hits 30,468, FEIN `82-0544687`
- Top candidate: `"AMAZON.COM SERVICES LLC"` (WA) — FEIN `91-1646860`, score `1.000`
- → Same name, **different FEINs**, different states. These are
   legally distinct employers (the VA one is the AWS subsidiary).
   **Do NOT merge.** Click "Create new canonical" — the dashboard
   will then preserve both as separate `canonical_employers` rows.
   This is the correct behaviour and the dashboard's entity-resolution
   layer relies on it.

**Pattern 3 — typo / suffix variant.**
- Unresolved: `"COGNIZANT TECH SOLNS US"` (TX) — hits 14, no FEIN
- Top candidate: `"COGNIZANT TECHNOLOGY SOLUTIONS US CORP"` (TX), score `0.625`
- → Same state, plausibly same entity, but the abbreviation is a real
   risk. Cross-check the record count — Cognizant has 65 K records. **Merge** if
   you're 95 %+ sure. If not, **Create new canonical** and let it
   accumulate a few more hits before deciding.

**Pattern 4 — junk row.**
- Unresolved: `"-"` (—) — hits 3, no FEIN, no city
- No similar candidates.
- → **Reject.**

---

## Cheat sheet — common decisions

| Situation | Action |
|---|---|
| Reviews — SOC looks right | **Accept** |
| Reviews — SOC looks wrong, you know correct one | **Override** with the BLS code |
| Reviews — can't tell, the job title is too vague | **Reject to quarantine** |
| Quarantine — you can read the title and guess the SOC | **Assign SOC manually** |
| Quarantine — title is `"X"`, `"-"`, or otherwise unrecoverable | **Drop** |
| Quarantine — title is generic but contextually parseable (employer hints at industry) | **Assign SOC manually** with a `Note` for traceability |
| Unresolved — trigram score ≥ 0.6 against a candidate, same FEIN | **Merge** |
| Unresolved — trigram score ≥ 0.6, no FEIN | Confirm the state matches, **Merge** |
| Unresolved — trigram score 0.4-0.6, FEIN matches | **Merge** (FEIN wins) |
| Unresolved — trigram score 0.4-0.6, no FEIN | Inspect names carefully; **Create new** if uncertain |
| Unresolved — different FEINs, same trade name | **Create new** (legally distinct entities) |
| Unresolved — junk name | **Reject** |

---

## Reference — routes & write-back semantics

### Routes

Public (no auth):

| Method | Path | Purpose |
|---|---|---|
| GET | `/login` | Login form |
| POST | `/login` | Submit password, set signed cookie |
| POST | `/logout` | Clear cookie |
| GET | `/healthz` | Liveness probe |
| GET | `/public/*` | CSS |

Protected:

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Dashboard with queue counts |
| GET | `/reviews` | Review queue list |
| GET | `/reviews/:filingYear/:id` | Inspect single review record |
| POST | `/reviews/:filingYear/:id/accept` | Keep current SOC, clear `requires_review` |
| POST | `/reviews/:filingYear/:id/override` | Replace SOC; sets `soc_source='operator'`, `soc_confidence=1.0` |
| POST | `/reviews/:filingYear/:id/reject` | Clear SOC, copy a fresh entry into `staging.quarantine_records` |
| GET | `/quarantine` | Quarantine queue list |
| GET | `/quarantine/:id` | Inspect single quarantine record |
| POST | `/quarantine/:id/assign` | Assign SOC manually, write back to `lca_records` (matched by `_nlp_id`), mark `reprocessed_at` |
| POST | `/quarantine/:id/drop` | Mark `reprocessed_at` without writing back |
| GET | `/unresolved` | Unresolved-employer list |
| GET | `/unresolved/:id` | Inspect; computes top-20 trigram-similar canonicals, state-filtered |
| POST | `/unresolved/:id/merge` | Merge into existing `canonical_employers.id`, backfill matching `lca_records` |
| POST | `/unresolved/:id/create` | Create a new canonical, then merge as above |
| POST | `/unresolved/:id/reject` | Mark `resolved_at` with `resolved_to_id = NULL` |

### Write-back semantics

Every operator action is a transactional write that mirrors how the NLP
worker writes its own results, so operator-modified rows are
indistinguishable from auto-classified rows downstream apart from audit
fields (`operator_action`, `operator_decided_at`, etc.).

**Reviews:**

| Action | `lca_records` patch |
|---|---|
| Accept | `requires_review=false`, `review_reason=null`, `operator_action='accepted'`, `operator_decided_at=now` |
| Override | `soc_code`, `soc_title`, `soc_confidence=1.0`, `soc_source='operator'`, `requires_review=false`, `operator_action='overridden'` |
| Reject | clears `soc_*` fields; appends a fresh row to `staging.quarantine_records` with `errors.type='operator_rejected_review'` |

**Quarantine:**

| Action | Effect |
|---|---|
| Assign | finds the originating `lca_records` row by `data->>'_nlp_id'` + `filing_year`; patches `soc_source='operator'`; marks `quarantine_records.reprocessed_at = NOW()`. If the originating record can't be found, still marks reprocessed and records `lca_record_updated: false` in `errors`. |
| Drop | only marks `reprocessed_at`; appends `operator_action='dropped'` to `errors`. |

**Unresolved:**

| Action | Effect |
|---|---|
| Merge | confirms target canonical exists; updates all `lca_records` where `lower(EMPLOYER_NAME)` matches and (if known) `EMPLOYER_STATE` matches and `canonical_employer_id` is NULL, setting the merged canonical id; bumps `canonical_employers.record_count`; marks `unresolved_employers.resolved_at` and `resolved_to_id`. |
| Create | if the unresolved row has a FEIN already in `canonical_employers`, prefers that existing canonical. Otherwise inserts a new `canonical_employers` row, then runs the same backfill as merge. |
| Reject | sets `resolved_at = NOW()` with `resolved_to_id = NULL`. No backfill. |

All three actions run in a transaction so partial failures roll back cleanly.

### Project layout

```
apps/operator-ui/
├── index.js              # Fastify entry: plugins, auth wall, route registration
├── lib/
│   ├── auth.js           # Login/logout routes + signed-cookie preHandler
│   └── queries.js        # All SQL — one function per UI action
├── routes/
│   ├── dashboard.js
│   ├── reviews.js
│   ├── quarantine.js
│   └── unresolved.js
├── views/                # EJS templates
│   ├── partials/         # header / footer / flash / decision-guide
│   ├── reviews/          # list.ejs + inspect.ejs
│   ├── quarantine/
│   ├── unresolved/
│   ├── login.ejs
│   ├── dashboard.ejs
│   └── error.ejs
├── public/style.css      # Single hand-written CSS file (no Tailwind/build)
├── Dockerfile            # Multi-stage pnpm build, mirrors apps/ingestor pattern
├── package.json
└── README.md             # this file
```

### Design choices

- **Server-rendered EJS, not a SPA.** The HITL surface is small and internal.
- **No ORM.** SQL goes through `@lca/db-lib`'s `getPool()` directly.
- **Trigram lookup for candidates, not pgvector.** `pg_trgm`'s `%` operator
  is fast in-Postgres and identical to what a SQL operator would write by
  hand. The 384-dim `employer_embeddings` index drives Layer 3 of
  automated resolution; reusing it from Node would mean wiring up the
  encoder, which we already pay for in the Python worker.
- **One env-var password, signed cookie.** Single-operator internal tool;
  a full user/role system would be over-engineering.
