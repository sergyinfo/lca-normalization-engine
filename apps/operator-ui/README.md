# operator-ui

Web UI for the human-in-the-loop (HITL) operator. Walks the three review queues
that the automated pipeline cannot resolve on its own and writes the operator's
decision back to PostgreSQL.

Built on Fastify with server-rendered EJS views — no JS build step, no SPA.
Reuses `@lca/db-lib` for the connection pool. Ships as Docker Compose service
`operator-ui` on port 8080.

---

## What It Does

| Queue | Source | Why records land here | Operator actions |
|---|---|---|---|
| **Reviews** | `lca_records` where `data->>'requires_review' = 'true'` | Low Stage 2 confidence, or Stage 3 LLM picked a SOC against a literal-string risk (short-title gate). | Accept current SOC · Override SOC · Reject to quarantine |
| **Quarantine** | `staging.quarantine_records` where `reprocessed_at IS NULL` | LLM declined to classify, or Zod validation failed at ingest time. | Assign SOC manually (writes back to `lca_records` via `_nlp_id`) · Drop |
| **Unresolved** | `staging.unresolved_employers` where `resolved_at IS NULL` | All three entity-resolution layers (FEIN / `pg_trgm` / `pgvector`) missed. | Merge into existing canonical (with `pg_trgm` similarity search and state filter) · Create new canonical · Reject |

All actions are transactional. Merge / create-new in the unresolved queue runs
a `lca_records` backfill so every matching `(employer_name, employer_state)`
row receives a `canonical_employer_id` in the same transaction.

---

## Auth

Single shared password. The login form posts the password to `/login`; on a
constant-time match the server sets a signed cookie `operator_sid`. All routes
except `/login`, `/public/*`, and `/healthz` require the cookie.

| Variable | Required | Description |
|---|---|---|
| `OPERATOR_PASSWORD` | yes | Shared operator password. Anything non-empty. |
| `SESSION_SECRET` | yes | HMAC key for cookie signing. **≥ 32 characters.** Generate with `openssl rand -hex 32`. |
| `OPERATOR_UI_PORT` | no | Host port (default `8080`). |
| `OPERATOR_UI_HOST` | no | Bind address (default `0.0.0.0`). |
| `DATABASE_URL` | yes | Same connection string as the rest of the stack. |

---

## Running

### Docker Compose (default for the full stack)

```bash
# .env: set OPERATOR_PASSWORD and SESSION_SECRET (≥ 32 chars)
docker compose up -d operator-ui
open http://localhost:8080
```

### Host process (for UI iteration)

```bash
pnpm operator:dev          # node --watch, auto-restart on edits
# or
pnpm operator:start        # production-style boot
```

Health probe (no auth):

```bash
curl -s http://localhost:8080/healthz
# {"ok":true}
```

---

## Routes

Public:

| Method | Path | Purpose |
|---|---|---|
| GET | `/login` | Login form |
| POST | `/login` | Submit password, set signed cookie |
| POST | `/logout` | Clear cookie |
| GET | `/healthz` | Liveness probe |
| GET | `/public/*` | CSS |

Protected (signed cookie required):

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

---

## Write-Back Semantics

Each operator action is the inverse of an automated decision; the writes mirror
how the NLP worker writes its own results, so operator-modified rows are
indistinguishable from auto-classified rows downstream apart from the audit
fields.

### Reviews

| Action | `lca_records` patch |
|---|---|
| Accept | `requires_review=false`, `review_reason=null`, `operator_action='accepted'` |
| Override | `soc_code`, `soc_title`, `soc_confidence=1.0`, `soc_source='operator'`, `requires_review=false`, `operator_action='overridden'` |
| Reject | clears `soc_*` fields, `operator_action='rejected_to_quarantine'`; appends a fresh row to `staging.quarantine_records` with `errors.type='operator_rejected_review'` |

### Quarantine

| Action | Effect |
|---|---|
| Assign | finds the originating `lca_records` row by `data->>'_nlp_id'` + `filing_year`; patches it with `soc_source='operator'`; marks `quarantine_records.reprocessed_at = NOW()`. If the originating record can't be found, still marks reprocessed and records `lca_record_updated: false` in `errors`. |
| Drop | only marks `reprocessed_at`; appends `operator_action='dropped'` to `errors`. |

### Unresolved

| Action | Effect |
|---|---|
| Merge | confirms target canonical exists; updates all `lca_records` where `lower(data->>'EMPLOYER_NAME')` matches and (if known) `data->>'EMPLOYER_STATE'` matches and `canonical_employer_id` is NULL, setting the merged `canonical_employer_id`; bumps `canonical_employers.record_count`; marks `unresolved_employers.resolved_at` and `resolved_to_id`. |
| Create | if the unresolved row has a FEIN that's already in `canonical_employers`, prefers that match (FEIN unique). Otherwise inserts a new `canonical_employers` row from the unresolved fields, then runs the same backfill as merge. |
| Reject | sets `resolved_at = NOW()` with `resolved_to_id = NULL`. No backfill. |

All three actions run in a transaction so partial failures roll back cleanly.

---

## Project Layout

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
│   ├── partials/         # header / footer / flash
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

---

## Design Choices

- **Server-rendered EJS, not a SPA.** The HITL surface is small and internal;
  every page is a few rows and a form. A build pipeline + JSON API would be
  more code without a user-visible benefit.
- **No ORM.** SQL goes through `@lca/db-lib`'s `getPool()` directly. The
  queries match the worker's write patterns one-to-one, so audit fields stay
  consistent.
- **Trigram-based candidate lookup, not pgvector.** The unresolved queue
  surfaces candidates via `pg_trgm`'s `%` operator and `similarity()` score —
  fast, in-Postgres, and identical to what a SQL operator would write by hand.
  The 384-dim `employer_embeddings` HNSW index drives Layer 3 of automated
  resolution; reusing it from Node would mean wiring up the
  `sentence-transformers` encoder, which we already pay for in the Python
  worker.
- **One env-var password, signed cookie.** This is a single-operator,
  internal tool. A full user/role system would be over-engineering for the
  current scope; if multi-operator support is ever needed, the cookie value
  can carry a username and the role check goes in `authPreHandler`.
