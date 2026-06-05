# analytics-web

Next.js 15 production analytics website for the LCA / H-1B corpus.
Companion to `apps/analytics-ui` (the thesis-grade persona dashboard) — this
one is the **entity-first, SEO-optimised, monetisable** surface intended for
real public traffic.

## Architecture (in one breath)

- **Next.js 15 App Router**, TypeScript, server components everywhere.
- **Data source: a read-only SQLite file** (`data/lca.db`, ~30-50 MB),
  rebuilt quarterly from the Postgres `analytics.*` matviews.
- **LLM-generated per-page summaries**, also stored in SQLite, regenerated
  on data change (skip-if-unchanged via a payload hash).
- **Optional MDX article overlays** per entity slug, picked up if present.
- **Static-friendly**: all entity pages have `generateStaticParams`; the
  whole site can be pre-rendered into HTML.
- **Self-hostable**: `output: 'standalone'` produces a single `node server.js`
  bundle suitable for a Hetzner / DigitalOcean VPS.

```
apps/analytics-web/
├── app/                    # Next.js App Router routes
│   ├── layout.tsx, page.tsx, not-found.tsx
│   ├── employer/[slug]/    # ~50 pages at launch
│   ├── occupation/[soc]/   # ~30 pages
│   ├── state/[state]/      # ~30 pages
│   ├── sector/[naics]/     # ~30 pages
│   └── api/v1/             # B2B paid API (key auth + rate limit)
├── content/articles/       # Optional MDX per entity: content/articles/<kind>/<slug>.mdx
├── data/lca.db             # Built by scripts/build-sqlite.ts (gitignored)
├── lib/
│   ├── db.ts               # better-sqlite3 singleton
│   ├── schema.ts           # SQLite DDL + EntityKind type
│   ├── queries.ts          # Typed read-only queries
│   ├── slugify.ts          # URL slugs + state/NAICS labels
│   └── llm/                # Provider-agnostic summary interface
├── scripts/
│   ├── build-sqlite.ts     # Postgres analytics.* → lca.db (quarterly)
│   └── generate-summaries.ts  # LLM → entity_summary (quarterly)
```

## Quarterly rebuild workflow

The site is a static-feeling product, but the data is regenerated each
quarter when DOL releases new LCA disclosures:

```bash
# 1. Refresh the upstream Postgres matviews (in the existing pipeline)
pnpm analytics:refresh-views

# 2. Rebuild the local SQLite file from those matviews
pnpm --filter analytics-web build:sqlite

# 3. Regenerate per-page LLM summaries (skips entities whose data didn't change)
LLM_PROVIDER=anthropic LLM_API_KEY=sk-ant-... \
  pnpm --filter analytics-web build:summaries

# 4. Build the Next.js production bundle and deploy
pnpm --filter analytics-web build
```

Or via the convenience wrapper:
```bash
pnpm --filter analytics-web build:data   # steps 2 + 3
```

## Configuration

Env vars used by the runtime app:

| Var | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_SITE_NAME` | `H1B Report`         | Brand name in header / metadata / OG watermark |
| `NEXT_PUBLIC_SITE_URL`  | `https://h1b.report` | Canonical origin for sitemap, OG, JSON-LD |
| `LCA_SQLITE_PATH`       | `./data/lca.db`      | Path to the read-only SQLite file |
| `LCA_KEYS_DB_PATH`      | `./data/keys.db`     | Path to the mutable API-keys SQLite file |
| `ADSENSE_CLIENT_ID`     | `ca-pub-…` (h1b)     | Google AdSense publisher id. `none` disables the loader; any other value overrides the built-in default. |
| `ADSENSE_SLOTS`         | `{}`                 | JSON map of AdSlot `name` → ad-unit id, e.g. `{"home-top":"1234567890"}`. Overrides ids set in the registry. |

**Ad slots:** every placement on the site is listed in **`lib/ad-slots.ts`** (the
single source of truth — name, where it appears, and ad-format). To wire a slot
after AdSense approval, set its `id` there **or** via `ADSENSE_SLOTS`. Until an id
is set, a slot renders a labeled placeholder in dev and nothing in prod (clean for
review). All slots are natively styled (`<AdSlot>` → site card + "Advertisement"
label). Entity pages are prerendered, so changing ids needs a rebuild.

Env vars used by `scripts/generate-summaries.ts`:

| Var | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `stub` | One of `stub`, `anthropic`, `openai`, `local` |
| `LLM_MODEL`    | provider-specific | Model identifier |
| `LLM_API_KEY`  | —     | Required for `anthropic`, `openai`, sometimes `local` |
| `LLM_BASE_URL` | provider-specific | For `local` / OpenAI-compatible endpoints |
| `LLM_CONCURRENCY` | `4` | In-process parallelism for summary calls |

Env vars used by `scripts/build-sqlite.ts`:

| Var | Default | Description |
|---|---|---|
| `DATABASE_URL`     | — (required) | Postgres connection string |
| `TOP_EMPLOYERS`    | `50` | Number of top sponsors to include |
| `TOP_OCCUPATIONS`  | `30` | Number of top SOCs to include |
| `TOP_STATES`       | `30` | States included (most have all 50, capped here for launch) |
| `TOP_SECTORS`      | `30` | NAICS sectors |

## LLM provider abstraction

`lib/llm/provider.ts` defines a single interface; implementations live in
sibling files. To swap providers, change one env var:

```bash
# Anthropic Claude (recommended for prose quality)
LLM_PROVIDER=anthropic LLM_MODEL=claude-sonnet-4-6 LLM_API_KEY=sk-ant-... pnpm build:summaries

# OpenAI
LLM_PROVIDER=openai LLM_MODEL=gpt-4o-mini LLM_API_KEY=sk-... pnpm build:summaries

# Self-hosted vLLM (reuse the Stage-3 GPU box, see root README §"Mode 3")
LLM_PROVIDER=local LLM_BASE_URL=https://abc123.ngrok-free.app/v1 \
  LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct LLM_API_KEY=<vllm-key> \
  pnpm build:summaries

# No network — deterministic placeholders, useful during scaffolding
LLM_PROVIDER=stub pnpm build:summaries
```

The provider is selected lazily so you can develop against the stub
without setting any keys.

## Status (scaffold phase)

Foundation in place:
- ✅ Next.js scaffold, layout, home page
- ✅ SQLite schema + typed query layer
- ✅ Postgres → SQLite build script
- ✅ Provider-agnostic LLM summary interface (Anthropic / OpenAI / local / stub)
- ✅ Summary generator with skip-if-unchanged

Next phases:
- ⏳ Entity page templates (employer / occupation / state / sector)
- ⏳ SEO surface (sitemap, robots, JSON-LD, OG images)
- ⏳ B2B API (`/api/v1/*` + key auth + rate limit)
- ⏳ AdSense slot wiring
- ⏳ Dockerfile + docker-compose integration
