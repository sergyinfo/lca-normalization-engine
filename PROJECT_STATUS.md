# Project Status Report

**Date:** 2026-05-26 PM (updated, late-2026-05-26: dead-link fix for cross-referenced employers — `state_top_employer` / `occupation_top_employer` / `sector_top_employer` no longer 404 when they point at a sponsor outside the global top-N; SQLite snapshot now backfills 600 **tail employers** with full SOC + yearly + outcomes data, kept out of the public `/employer` index via `rank IS NULL`. SEO canonical audit — `/search?q=...` is now `noindex, follow`; compare pages canonicalise the slug pair alphabetically so `A/B` and `B/A` fold onto the same URL. **Numbered pagination** (`?page=N` via `usePagination` history-API hook — no `useSearchParams` to preserve SSG) shipped across all four index pages and all six ranking pages with 50 rows / page. **Page minimap** (left-edge rail of color-coded section blocks + viewport overlay, hidden under `xl:`) lives on every detail / compare / index / ranking page — 18 routes. Each section block uses a stable hue from an 8-entry palette so neighbours stay distinguishable beyond just block height; viewport overlay glides with a 220 ms ease-out-quint curve; hovering a block scales it 1.4× toward the content. Polish pass: pagination now scrolls to the **table card** (not the document top) so the new page's rows are immediately visible; cursors are `pointer` on all minimap blocks, pagination buttons, region chips, and the metric toggle; minimap labels are siblings of the scale-transformed buttons so the text stays crisp under hover. Region-filter consistency on `/state`: the Biggest Share Movers chart now uses the **selected region's pie** as the denominator (matches the KPI strip + choropleth); chip counts are restricted to states that have a corresponding choropleth geometry, so the Territories chip auto-hides when no territory is mappable (us-atlas covers 50 states + DC only). Earlier 2026-05-26: interactive **entity explorer** pattern across the four index pages; `/state` choropleth with USPS labels + hover side panel + Census-region chips + per-100k toggle. — 2026-05-25: auto-embed sweep wired into the NLP worker + `nlp-engine-smoke.yml` CI workflow. — 2026-05-20 baseline: Analytics 2.0 website shipped end-to-end with full AWS-native CDK deployment. Pipeline data layer unchanged from the 2026-05-12 snapshot below.)

---

## Quick orientation

The project now has **two distinct halves**:

1. **Data pipeline (`apps/ingestor`, `apps/harvester`, `apps/operator-ui`, `apps/analytics-ui`, `packages/nlp-engine`, `packages/db-lib`)** — the original system: ingests DOL XLSX files, normalises SOCs and employers, surfaces operator HITL queues. Internal/admin facing. Fully complete as of 2026-05-13. See §"What You Can Do Right Now" and §"Step 1–6 history" below.

2. **Public analytics website (`apps/analytics-web`)** — built 2026-05-14 → 2026-05-20. Production-grade Next.js site for **h1b.report**, served from a baked-in SQLite snapshot of the canonical pipeline output. Includes a complete deployment story (Docker single-VPS or AWS-native CDK) and a quarterly auto-rebuild pipeline. See §"Step 7" below.

The two halves are decoupled by `apps/analytics-web/data/lca.db` — a small (~0.4 MB) SQLite snapshot built by `pnpm --filter analytics-web build:sqlite` from the live Postgres + matviews. The website never touches Postgres at runtime.

---

## What This Project Does

US employers must file a **Labor Condition Application (LCA)** with the Department
of Labor every time they sponsor a foreign worker (most commonly on an H-1B visa).
The DOL publishes all of these filings publicly as quarterly Excel files. Over the
last decade they add up to **12 million+ records**.

This project is a data pipeline that:

1. **Collects** every historical and future LCA Excel file from the DOL website
   automatically.
2. **Stores** all records in a partitioned PostgreSQL database, queryable by year,
   employer, job title, wage, and location.
3. **Normalises job titles** — free-text entries like `"Sr. Software Eng III"` or
   `"SWE"` are mapped to a standard government occupational code (SOC) so records
   across different employers and years can be compared consistently.
4. **Deduplicates employers** — the same company appears under hundreds of spelling
   variants (`"Google Inc."`, `"Google LLC"`, `"GOOGLE"`, `"Google US"`). The
   pipeline resolves all of these to a single canonical entity.

The end result is a clean, queryable dataset ready for labour market analysis,
wage trend research, and employer benchmarking.

---

## What You Can Do Right Now

The full pipeline is now closed-loop end-to-end: ingest → classify → resolve
employer → write back to PostgreSQL.

### One-shot setup

```bash
pnpm docker:up        # PostgreSQL (with pgvector) + Redis + workers
pnpm db:init          # create all tables, indexes, extensions

# Seed the SOC alias table (~6.5K BLS title mappings) — only once
DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \
  load-dmtf --file ./data/dmtf.xlsx

pnpm db:status        # verify everything is healthy and empty
```

### Ingest and enrich

```bash
pnpm seed             # ingest XLSX files from ./data
pnpm queue:stats      # watch the queue drain
pnpm db:status        # see records, classifications, canonical employers
```

### What gets produced

State of the database after a full 6-year re-ingest run (FY2020 → FY2025,
24 LCA Disclosure files, **3,831,919** records):

| Table | Rows | Notes |
|---|---:|---|
| `lca_records` | 3,831,919 | All six years; partitioned by `filing_year`. **3,650,080 classified (95.3 %)**; **3,811,573 (99.47 %)** carry a `canonical_employer_id` after the full-cascade backfill. 0 records with `requires_review=true` after the run. |
| `soc_aliases` | 16,079 | 13,003 BLS DMTF + 3,076 self-bootstrapped via `bootstrap-aliases` after ingestion |
| `employer_soc_consensus` | 17,354 | Per-(FEIN, normalised title) → SOC mapping, rebuilt by `consensus:refresh` post-ingest |
| `canonical_employers` | **146,206** | 92,289 from Layer 1 FEIN matches (FY2024+FY2025) + 53,917 inserted on miss by the full-cascade backfill against `unresolved_employers` |
| `employer_embeddings` | **146,206** | 384-dim sentence-transformer vectors of `canonical_name`; HNSW cosine index. 1-to-1 with `canonical_employers`. |
| `staging.unresolved_employers` (open) | **0** | All 157,612 entries resolved by the full-cascade backfill on 2026-05-12 (Layer 2: 53.2 %, Layer 3: 14.7 %, new canonicals: 32.1 % for the second batch — combined totals in `INGEST_RUN_REPORT.md` Phase 9). |
| `staging.quarantine_records` (open) | 181,839 | Low Stage 2 confidence — deferred for Stage 3 LLM reclassify on GPU (250+ h on Mac CPU) |

SOC classification breakdown across the full 3.83 M run:

| Source | Count | % of classified | Notes |
|---|---:|---:|---|
| Stage 1 — DMTF / bootstrap exact match | 1,516,117 | 41.5 % | BLS Direct Match Title File + cross-employer aliases |
| Stage 2 — Semantic retrieval (≥ 0.7) | 1,898,690 | 52.0 % | sentence-transformer cosine similarity |
| Stage 0 — Employer consensus | 235,273 | 6.4 % | Per-(FEIN, title) authoritative; accrues during the run as the per-employer table fills |
| **Classified total** | **3,650,080** | **100 %** | (= 95.3 % of `lca_records`) |
| Quarantined (low Stage 2 confidence) | 181,839 | — | 4.7 % of `lca_records`; awaiting Stage 3 LLM reclassify |
| Flagged `requires_review` | 0 | — | None left active at end of run |

### Query the database

```sql
-- Top 10 employers by LCA filing volume
SELECT canonical_name, fein, employer_state, record_count
FROM   canonical_employers
ORDER  BY record_count DESC
LIMIT  10;

-- Classified Software Engineer filings with their canonical employer
SELECT data->>'JOB_TITLE'              AS job_title,
       data->>'soc_code'               AS soc,
       data->>'canonical_employer_id'  AS canonical_id,
       data->>'EMPLOYER_NAME'          AS raw_employer
FROM   lca_records
WHERE  data->>'soc_code' = '15-1252'
LIMIT  5;
```

---

## What's Partially Working

| Feature | What works | What's still missing |
|---|---|---|
| **SOC classification** | Stages 0 → 1 → 2 all firing inline at scale — 95.3 % coverage across 3.83 M records, 0 errors. | Stage 3 LLM-on-residual is in code but **skipped** for this run: 181,839 quarantined records × 5–10 s Ollama call ≈ 250+ hours on Mac CPU. Needs batched-LLM mode and/or a GPU host before it can be run end-to-end. |
| **Entity resolution** | All three layers proven end-to-end on 3.83 M records. Layer 1 populated 92,289 canonicals on FY2024+FY2025; the full-cascade backfill (`canonical:backfill-full`) drove `unresolved_employers` to **0** and lifted `canonical_employers` to **146,206** (99.47 % LCA coverage). | 20,346 LCA records (0.53 %) still have no `canonical_employer_id` — these are rows whose `EMPLOYER_NAME` never appeared in the `unresolved_employers` queue (NULL / whitespace-only names, or normalisation edge-cases). Will fall through to `quarantine:reclassify` (Stage 3 LLM) or a future name-normalisation pass. |

---

## What's Not Working Yet

- **Stage 3 LLM reclassify at scale** — `quarantine:reclassify` works, but
  181,839 records on a Mac CPU is uneconomical (~250 h). Needs batched-LLM
  mode (Ollama `/api/generate` with `stream=false` over a connection pool)
  and/or running on an A10G/L4 GPU. Until then, the 4.7 % quarantine
  residue stays unresolved.
- ~~**Periodic embedding refresh**~~ ✅ *done 2026-05-25.* The NLP worker
  now sweeps for unembedded `canonical_employers` after every batch (and
  once at startup), reusing the in-memory sentence-transformer encoder.
  Covers canonicals from all three creation paths (worker FEIN insert,
  `backfill-canonical-full`, operator-ui `createCanonicalAndMerge`).
  Idempotent + advisory-locked for safe concurrent workers. Disable with
  `NLP_AUTO_EMBED=0`. The `employers:embed` CLI is kept as a manual
  catch-up tool. See `entity_resolution.py::embed_pending`.
- **DEBUG-level `pg_trgm` log spam in `nlp-worker`** — visible in
  `INGEST_RUN_REPORT.md` snapshots; lower `LOG_LEVEL` to `INFO` for the
  worker in `.env` to cut disk pressure on long runs.
- **Tests and CI/CD** — partially done. `nlp-engine-smoke.yml` runs two
  smoke jobs on PRs touching the Python package (`wiring` no-infra +
  `embed` with a pgvector service container). `build-and-deploy.yml`
  covers the analytics-web app. No unit-test suite anywhere; ingestor /
  harvester have no workflow yet.

---

## Next Steps

These are ordered by impact — each one unlocks something visible in the pipeline.

### Step 1 — Operator HITL UI ✅ *(done 2026-05-10)*

Shipped as `apps/operator-ui` — Fastify + EJS web app, single shared
password (`OPERATOR_PASSWORD`) with a signed-cookie session
(`SESSION_SECRET`). Runs as a Docker Compose service `operator-ui` on
port 8080.

Walks all three queues:
* `requires_review = true` records in `lca_records` — accept SOC /
  override SOC / reject to quarantine.
* `staging.quarantine_records` — assign SOC manually (writes back to
  `lca_records` via `_nlp_id`) / drop.
* `staging.unresolved_employers` — merge into existing canonical
  (with `pg_trgm` similarity search and state filter), create new
  canonical, or reject. Merge backfills `canonical_employer_id` on
  matching `lca_records`.

Bring up:
```bash
docker compose up -d operator-ui   # http://localhost:8080
# or for host iteration:
pnpm operator:dev
```

**Outcome:** All HITL surfaces are now walkable through a browser. No
more ad-hoc SQL.

### Step 2 — Full 6-year re-ingest exercise ✅ *(done 2026-05-11/12)*

FY2020 → FY2025 (24 LCA Disclosure files, 3.83 M records) ingested
end-to-end with 0 errors and 0 failed BullMQ jobs over ~13 h 45 m of
unattended NLP drain. Full timeline, snapshots, and findings recorded in
[`INGEST_RUN_REPORT.md`](project_notes/INGEST_RUN_REPORT.md).

Key takeaways from this exercise:

* **DOL FEIN coverage cliff** — FY2020–FY2023 disclosure files have
  **0 % EMPLOYER_FEIN**; FY2024–FY2025 have 100 %. Layer 1 is therefore
  data-dead on the first four years. Documented as a data quirk to plan
  around, not a code defect.
* **Layer 1 explosion confirmed** — `canonical_employers` jumped from
  3 → 92,289 the moment FY2024/FY2025 batches surfaced, matching the
  pre-run hypothesis.
* **Post-ingest chain** (`consensus:refresh` → `bootstrap-aliases` →
  `employers:embed`) ran cleanly. `canonical:backfill` is a no-op for
  our quarantined-record orphans because their FEINs were never
  registered as canonicals.
* **Stage 3 reclassify** skipped because the 181 K residue is too large
  for Mac CPU latency.

### Step 3 — Layer-2/3 + UPSERT canonical backfill ✅ *(shipped & executed 2026-05-12)*

New CLI `backfill-canonical-full` resolves `staging.unresolved_employers`
end-to-end via the full Layer 1 → 2 → 3 cascade and **inserts a fresh
`canonical_employers` row + its embedding when no match is found above
threshold** (the older `backfill-canonical-ids` was Layer-1-only and could
not UPSERT, which is why it ran 9 hours as a no-op on this corpus).

What was built:

* **`packages/nlp-engine/src/lca_nlp_engine/backfill_canonical_full.py`** —
  batched cascade with state-blocked `pg_trgm`, HNSW `pgvector`, and
  per-batch encoder calls (5–10× faster than per-row). Includes
  `--dry-run`, `--no-backfill`, `--trgm-threshold`, and
  `--vector-max-distance` flags. Registered as `pnpm canonical:backfill-full`.
* **Three new expression indexes in `ensureSchema()`**, propagated to
  every `lca_records_YYYY` partition:
    - `idx_lca_records_employer_name_state` —
      `(lower(EMPLOYER_NAME), EMPLOYER_STATE)` for the bulk merge JOIN.
    - `idx_lca_records_canonical_missing` —
      `(id, filing_year) WHERE NOT (data ? 'canonical_employer_id')`
      for orphan scans.
    - `idx_lca_records_employer_fein` —
      partial expression on `EMPLOYER_FEIN`.

  EXPLAIN ANALYZE confirms the new composite index drops per-merge
  UPDATE wall time from **~14 s → ~2 s** (with `enable_seqscan = off`
  in the backfill session to dodge stale-stats planner mispicks).
* Operator-UI's `mergeUnresolved` / `createCanonicalAndMerge` SQL also
  benefits from the same composite index — same write path, now indexed.

Full run executed against all 157,612 open `unresolved_employers`
(across two CLI sessions; the script's idempotency carried us through
a misjudged kill of the first batch):

| Pile | Run 1 | Run 2 | Combined |
|---|---:|---:|---:|
| Entries processed | 80,896 | 76,716 | **157,612** |
| New canonicals inserted | 29,319 | 24,598 | **53,917** |
| Wall time | ~ 2 h 33 min | ~ 2 h 6 min | **~ 4 h 39 min** |

Run-2 cascade composition: Layer 2 53.2 %, Layer 3 14.7 %, new
canonical 32.1 %.

**Outcome:** `unresolved_employers` is at zero, `canonical_employers`
grew to 146,206, and `lca_records` canonical coverage is 99.47 %.
Full timeline + numbers in [`INGEST_RUN_REPORT.md`](project_notes/INGEST_RUN_REPORT.md)
Phase 9.

To execute:
```bash
DATABASE_URL=... pnpm canonical:backfill-full          # process all open
DATABASE_URL=... packages/nlp-engine/.venv/bin/backfill-canonical-full \
    --dry-run --limit 1000                             # sample first
```

### Step 4 — Analytics dashboard ✅ *(done 2026-05-13)*

Shipped as `apps/analytics-ui` — Fastify + EJS + Chart.js, public read-only
app on port 8081. Four persona pages over the canonicalised corpus:

| Page | Audience | Headline question |
|---|---|---|
| `/journalist` | Public, reporters | Who sponsors H-1Bs, where, how much? |
| `/jobseeker`  | Career researchers | What's the prevailing wage for my role + city? |
| `/policy`     | Labour economists | How is the program evolving over time? |
| `/academic`   | Thesis examiner | How does the pipeline produce these numbers? |

Backed by **12 materialized views + 1 plain view** in a new `analytics.*`
schema (`apps/analytics-ui/db/analytics_views.sql`) — without them a naive
`count(*)` over the 3.83 M-row table takes ~75 s cold; the matviews drop
page paint to **16-552 ms** cold / **7-117 ms** warm. Total matview
storage: ~29 MB.

Full data walkthrough with worked persona-by-persona analysis in
[`project_notes/analytics_ui.md`](project_notes/analytics_ui.md). The
defence story: every panel is a question the pipeline made cheap to ask
— *the value of normalisation is everything past this page.*

Bring up:
```bash
DATABASE_URL=...  pnpm analytics:bootstrap-views     # one-shot, ~30-45 min
docker compose up -d analytics-ui                    # http://localhost:8081
DATABASE_URL=...  pnpm analytics:refresh-views       # after data changes
```

**Outcome:** the corpus is now legible to four different audiences without
any SQL. Defense-demo URL ready.

### Step 5 — Stage 3 LLM reclassify on GPU

Run `quarantine:reclassify` on a rented A10G/L4 against the 181,839 open
quarantine records (expected wall time ~5–10 h on a single GPU vs
~250 h on Mac CPU). Drives quarantine residue to near zero.

### Step 6 — Tests + CI/CD ⚠️ *(partially done 2026-05-20 → 2026-05-26)*

Two GitHub Actions workflows:

1. `.github/workflows/build-and-deploy.yml` — ships the analytics-web app
   end-to-end: typecheck → optional Postgres-restore + SQLite-rebuild →
   Docker image build → GHCR push → SSH-deploy → smoke test. Manual
   dispatch with `refresh_data: true` triggers a full quarterly rebuild
   from a Postgres dump.

2. `.github/workflows/nlp-engine-smoke.yml` *(added 2026-05-25)* — two
   smoke jobs for the Python `nlp-engine`:
   - **`wiring-smoke`** — no infra, no model. Catches
     import / signature / env-parsing regressions in seconds.
     (`packages/nlp-engine/scripts/smoke_wiring.py`)
   - **`embed-smoke`** — spins up `pgvector/pgvector:pg16` as a service
     container, applies the schema via `cli-tool db:init`, downloads the
     sentence-transformer (HF cache cross-run), then end-to-end exercises
     `CompanyDeduplicator.embed_pending` with a sentinel canonical and
     asserts a 384-dim L2-normalised vector lands.
     (`packages/nlp-engine/scripts/smoke_embed.py`)

Both scripts are runnable locally too: `pnpm smoke:wiring` /
`pnpm smoke:embed`.

**Schema self-install fix (2026-05-26).** First green run of
`embed-smoke` in CI revealed that `db-lib::ensureSchema` was creating
the `gin_trgm_ops` trigram index without first running `CREATE EXTENSION
pg_trgm`. The local development DB had the extension installed by hand
months ago, so the bug never surfaced. Now `ensureSchema` declares both
`pg_trgm` and `vector` at the top of its body so a fresh Postgres
(`pgvector/pgvector:pg16` in CI) bootstraps cleanly with no operator
intervention. Verified against a throwaway DB that had zero extensions
installed.

**Still missing:** unit tests for the classifier, entity resolver,
Pydantic models, ingestor. Web app has no automated test suite (manual
smoke test in `scripts/smoke-test.sh` exercises 21 routes). The
ingestor / harvester have no CI yet.

### Step 7 — Public Analytics Website + Production Infrastructure ✅ *(done 2026-05-14 → 2026-05-20, expanded 2026-05-26)*

Shipped as `apps/analytics-web` — a full-stack Next.js 15 production
site for **h1b.report**. ~200 pre-rendered entity pages over a static
SQLite snapshot of the canonicalised corpus, three deployment topologies
(single VPS / VPS + CDN / full AWS-native), quarterly auto-rebuild
pipeline.

**2026-05-26 follow-up — entity-explorer pattern across all four index
pages.** `/employer`, `/occupation`, `/state`, `/sector` now share the
same interactive shell: KPI strip at the top, biggest-share-movers
Recharts diverging bar chart, search-as-you-type, and a sortable table.
`/state` adds three state-only extras on top of the shared base: a US
choropleth (USPS labels at centroids, leader-line callouts for the
tiny eastern states, hover-driven side panel with rank + sparkline +
top sponsor), Census-region chips (Northeast / South / Midwest / West /
Territories) that filter both the map dim-state and the table, and an
"Absolute filings" ↔ "Per 100k workers" metric toggle backed by a
hand-curated BLS LAUS workforce table.

#### What got built

| Component | Where | What |
|---|---|---|
| **Next.js 15 app** | `apps/analytics-web` | Tailwind 4 + shadcn/ui + Geist fonts. App Router, RSC, server-rendered static pages + a small dynamic surface (search, /api/v1, /compare on-demand, /archive runtime, OG images). React 19. Output: standalone server. |
| **SQLite snapshot layer** | `lib/schema.ts`, `lib/queries.ts`, `lib/db.ts` | 12 tables baked into a 0.4 MB SQLite file. Built quarterly from `analytics.*` matviews via `scripts/build-sqlite.ts`. Includes 4 entity types (employer/occupation/state/sector) + cross-references + yearly trends. Reads via built-in `node:sqlite` (Node 22.5+), no native compile. |
| **Entity pages** | `app/{employer,occupation,state,sector}/[slug]/page.tsx` | One per top-N entity. SEO-friendly slugs (e.g. `/sector/professional-scientific-and-technical-services-54`, `/occupation/software-developers-15-1252`). EntityHero + Summary + LLM article overlay + outcome stacked bar + horizontal bars + line charts + ComparePicker + SeeAlsoLinks. |
| **List pages** | `app/{employer,occupation,state,sector}/page.tsx` | Sortable tables with inline sparklines + MiniBar proportional bars per row. SortableTable client wrapper hydrates over existing markup via `data-sort-*` attributes (no per-page refactor). |
| **Ranking pages** | `app/{top-h1b-sponsors,top-h1b-occupations,top-h1b-states,h1b-by-industry,highest-paying-h1b-jobs,cleanest-h1b-sponsors}/page.tsx` | Six leaderboards. Each has a pre-table visualisation card (Top-10 HorizontalBarSvg + Pareto-distribution chart). All cells sortable. |
| **Compare feature** | `app/compare/{employer,occupation,state,sector}/[...slugs]/page.tsx`, `components/ComparePicker.tsx`, `components/CompareSwapper.tsx` | Side-by-side 2-way entity comparison for all four entity types. KPI table with ▲ winner indicators. ComparePicker on entity pages (suggested peers + search). CompareSwapper on compare pages (swap either side without leaving). Designed for future N-way comparison. |
| **Archive snapshots** | `data/archives/<YYYY-qN>.lca.db`, `app/archive/...` | Every quarterly rebuild saves a byte-identical frozen copy. Six archive routes (`/archive`, `/archive/[label]`, 4 entity sub-routes). `withArchiveDb(label, fn)` uses AsyncLocalStorage to scope queries to the right SQLite file — all existing query helpers work unchanged. Archive pages emit `noindex, follow` + `rel="canonical"` pointing at the live equivalent. |
| **SEO redirect handling** | `redirects` table + `next.config.ts redirects()` | When an entity drops from the top-N during a rebuild, build script searches archives newest-first for a target. 301-redirects the old slug → most recent archive that still has the entity. Falls back to parent list if no archive has it. Built into the framework at build time via Next.js redirects config. |
| **Sitemap + freshness signals** | `app/sitemap.ts`, `app/robots.ts`, EntityHero `updatedAt` | Sitemap stamps `lastModified` from `site_kpis.generated_at` so Google sees fresh signal each rebuild. EntityHero shows an "Updated MMM YYYY" badge near the title. |
| **Dark mode** | `next-themes`, `components/ThemeProvider.tsx`, `ThemeToggle.tsx`, `globals.css` `.dark` palette | Two-state toggle (light ↔ dark) driven by resolvedTheme so every click flips what the user sees. localStorage persistence. No-flash via inline script before first paint. Every chart's tooltip/grid/track colours flip via CSS variables. |
| **Charts (13 components)** | `components/charts/` | HorizontalBarSvg (HTML/CSS, hover tooltips), HistogramSvg (sorted Pareto for long-tail data), Sparkline (SSR SVG), MiniBar (SSR SVG), StackedBarSvg (HTML/CSS), UsChoropleth (interactive, Albers-projected, labelled, hover-panelled), BiggestMoversChart (Recharts diverging horizontal bar, themed +/- via `--color-primary`/`--color-destructive`), DonutChartClient (Recharts with vertical legend), LineChartClient, BarChartClient, LevelLadderClient, AreaBandChartClient, HomeWageChartClient. All themed via shared `recharts-shared.ts` tokens. |
| **US choropleth on /state** | `components/charts/UsChoropleth.tsx`, `lib/us-states-geo.ts`, `scripts/build-us-geo.ts` | Interactive SVG choropleth of the 50 states + DC. Paths + centroid label anchors baked at build time from `us-atlas/states-albers-10m.json` (Albers USA grid, 975×610) via `d3-geo` + `topojson-client` (devDeps only — zero runtime cost). USPS labels at centroids with leader-line callouts for the nine tiny eastern states (CT/RI/NJ/DE/MD/DC/NH/VT/MA). Hover/focus a state → its path gets a primary-color stroke, neighbours dim to 55 %. Side panel (right column on desktop, bottom on mobile) shows the hovered state's rank / filings / % of national / yearly sparkline / top sponsor / "View details" CTA. Default panel content is rank #1 so the page is informative even before mouse-move. Log-scaled fill via `color-mix(in oklab, ...)` handles the California outlier without flattening the long tail. |
| **Entity explorer pattern** | `components/{StateExplorer,SectorExplorer,OccupationExplorer,EmployerExplorer}.tsx`, `components/EntityKpiStrip.tsx`, `components/charts/BiggestMoversChart.tsx` | Shared client wrapper for all four index pages. Owns local UI state (search, plus region + metric for `/state`), derives a KPI strip (total filings / entities tracked / top-5 concentration / biggest YoY share mover with up/down trend icon), a biggest-share-movers chart (top-12 by \|Δpp\|, sorted desc → asc, +/- colored via theme tokens), and the existing sortable table filtered live by free-text search. Movers logic uses a per-page floor (≥ 1k filings for sectors, 2k for sponsors, 5k for occupations) so rare niche codes can't dominate the headline by flipping 100 % of nothing. Employers use a synthetic ticker label (first whitespace-token uppercased, max 12 chars) for the chart y-axis since they have no 2-letter code. |
| **/state region + per-capita layer** | `components/StateExplorer.tsx`, `lib/us-regions.ts`, `lib/us-workforce.ts` | State-only extras on top of the shared explorer. Census-region chips (Northeast / South / Midwest / West, plus Territories *if any territory state is renderable on the map*) filter both the table and the choropleth (non-region states dim to 0-value fill). Chip counts use the intersection of `rows` ∩ `US_STATES_GEO` so the Territories chip self-hides — us-atlas only ships 50 states + DC geometry, no PR/GU/MP/VI paths, so a Territories filter would dim the whole map. Choropleth's default-active state is the first datum with a non-zero value (was: array head), so clicking a sparse region no longer leaves the original #1 state falsely highlighted. Per-capita toggle switches the map's value from absolute filings to filings-per-100k-workers using a hand-curated BLS LAUS state workforce table baked into `lib/us-workforce.ts` (refresh annually). Biggest Movers chart now uses the **selected region's pie** as its share denominator — when "Northeast" is selected, the chart shows movers within Northeast filings, not nationally. Card title + description swap to "the {Region} region's" wording so the unit is honest. |
| **Tail employer backfill** *(2026-05-26)* | `apps/analytics-web/scripts/build-sqlite.ts`, `apps/analytics-web/lib/schema.ts` (`rank` is now nullable) | Cross-references from `/state/[slug]` / `/occupation/[slug]` / `/sector/[slug]` can point at sponsors not in the global top-200 (e.g. Bering Strait School District is #1 in Alaska, ~#1500 nationally). Build script now tracks every referenced canonical_id, then post-pass-fetches `mv_employer_outcomes` + computes per-employer top-10 SOCs + yearly trend directly from `lca_records` (the existing `mv_employer_growth_by_year` matview is capped at top-300). Tail rows land in `employer` with `rank=NULL` so they generate `/employer/<slug>` static params + complete detail pages but stay out of the `/employer` index, biggest-mover chart, and KPI denominators (filtered via `WHERE rank IS NOT NULL` in `listTopEmployers` + `listCleanestEmployers`). 600 extra pages, SQLite 1.0 MB → 2.0 MB. |
| **Pagination** *(2026-05-26)* | `components/Pagination.tsx` + `components/PaginatedRankingTable.tsx` (+ inline use in all four `*Explorer.tsx`) | Numbered pagination with First · Prev · 1 … 5 6 7 … N · Next · Last and "Showing X–Y of Z" copy. URL synced via `?page=N` using `useState` + `window.history.pushState` (deliberately not `useSearchParams` — that bails the page out of SSG and breaks the SEO-canonical SSR HTML). Page 1 omitted from URL. Hard reloads of `?page=2` paint with page 1 and re-render to page 2 after hydration. Browser back/forward synced via `popstate`. Search / region / metric changes reset page to 1. Clicking a page button scrolls the **table card** (nearest `[data-section-id]` ancestor of the pagination nav) to the viewport top with a 16 px margin — not the document top, which previously hid the table behind the hero/KPI strip. Buttons + active page indicator both have `cursor-pointer` (vs Tailwind preflight's default). 50 rows per page; control hides when total ≤ 1 page (e.g. `/sector` 30 rows, `/h1b-by-industry`). Applied to all four index pages and all six ranking pages. |
| **Page minimap** *(2026-05-26)* | `components/PageMinimap.tsx` | Fixed pill against the **left viewport edge** (`left-2`, hidden under `xl:` breakpoint) of stacked color-coded blocks — one per `[data-section-id]` element, height proportional to section size, **each block a stable hue from an 8-entry palette** (blue / teal / amber / violet / cyan / pink / lime / coral, indexed by section position) so neighbours stay visually distinguishable beyond just height. Translucent viewport rectangle glides with a **220 ms ease-out-quint** cubic-bezier curve as the user scrolls. Hovering a block scales it 1.4× toward the content (left-anchored transform origin) and reveals a popover label to its right with a matching color dot; the active block shows the label permanently + a colored glow shadow. Each block is a `<div class="group">` wrapper containing the scale-transformed `<button>` and a sibling `<span>` label — the label is *not* a child of the transformed button so its text stays crisp under hover. `cursor-pointer` on every block. rAF-throttled scroll + resize listeners; `popstate`-aware. Wired into 18 routes: 4 entity detail + 4 compare + 4 index + 6 ranking pages. |
| **Canonical-tag hygiene** | `lib/seo.ts`, `app/layout.tsx`, every `page.tsx` | `metadataBase = SITE_URL` so relative paths become absolute. Every route uses `entityMetadata({ path })` which emits `<link rel="canonical">`. Archive routes canonical to the live equivalent + `noindex, follow`. Pagination canonicals naturally strip `?page=N` because metadata is route-static. `/search?q=…` is `noindex, follow` via dynamic `generateMetadata` so query permutations don't burn crawl budget; empty `/search` stays `index, follow`. Compare pages canonicalise the slug pair alphabetically (`/compare/employer/A/B` and `/B/A` both canonical to the sorted form). |
| **Tables** | `components/ui/table.tsx`, `components/SortableTable.tsx` | shadcn primitives polished with zebra striping (`bg-muted/60` even rows), blue-tinted hover, themed headers. Client-side sort wrapper reads `data-sort-key` + `data-sort-value` attributes and re-appends tbody DOM — no data-driven refactor at call sites. |
| **LLM summaries** | `lib/llm/provider.ts`, `lib/llm/{stub,anthropic,openai,local}.ts`, `scripts/generate-summaries.ts` | Provider-agnostic abstraction. 141 entity summaries (1 site + 50 employer + 30 occupation + 30 state + 30 sector). Skip-if-unchanged via SHA-256 `data_hash`. Cost ~$1 with Claude Sonnet, ~$0.05 with GPT-4o-mini, free with reused vLLM GPU. Currently shipping stub placeholders pending API key configuration. |
| **MDX article overlay** | `content/{employer,occupation,state,sector}/<slug>.mdx`, `lib/article.ts` | Per-entity editorial content rendered below the LLM summary. Optional; entity page works without one. Pure code commits, no data-pipeline step. |
| **AdSense + B2B API** | `lib/adsense.ts`, `lib/api/auth.ts`, `lib/keys-db.ts`, `app/api/v1/*`, `app/api/docs/page.tsx` | AdSense via `ADSENSE_CLIENT_ID` + `ADSENSE_SLOTS` env (transparent placeholders when unset). Read-only JSON API with Bearer + X-API-Key auth, SHA-256 hashed keys (`lcak_` prefix) in a separate `keys.db` volume-mounted SQLite, in-memory rolling 24h rate limiter, three tiers (free 100, pro 10k, enterprise 1M req/day). |
| **Entity name disambiguation** | `scripts/build-sqlite.ts` | At build time, detects same-canonical_name collisions in top-N (e.g. two "AMAZON.COM SERVICES LLC" rows with different FEINs). Appends state or FEIN last-4 to the displayed name. Slugs and IDs untouched — only the display string changes. |

#### Deployment story

Two complete deployment paths, both documented end-to-end:

**Path A — Single VPS** (Hetzner CX22 ≈ €5/mo). `DEPLOY.md` covers it
in ~1000 lines: build pipeline, lifecycles, ops runbook, Nginx reverse
proxy config, systemd auto-refresh timer, GitHub Actions workflow.
Helper scripts: `scripts/release.sh` (canonical rebuild + tagged
rollback) and `scripts/smoke-test.sh` (21 critical routes verified).

**Path B — AWS-native CDK** (`infra/aws/`, ~$3–6/mo). Three stacks:

| Stack | What |
|---|---|
| `LcaSharedStack` | S3 (lca.db versioned, PG snapshots, ingest scratch), ECR repo, Secrets Manager (Anthropic key + PG password) |
| `LcaDataPipelineStack` | EventBridge schedule → Lambda DOL-checker → Step Functions → ephemeral EC2 c6i.2xlarge (cloud-init ingests, builds, pushes Lambda image, self-terminates) → SNS notifications. CloudWatch Agent + Docker awslogs driver ship every log to CloudWatch. |
| `LcaServeStack` | Lambda Container (Next.js standalone via AWS Lambda Web Adapter) + CloudFront + S3 static origin. Security headers, ARM64. |
| `LcaBudgetsStack` | 5 budgets (monthly total, per-component, quarterly burst, annual cap) with 50/80/100% actual + forecasted alerts. Cost Anomaly Detection. SNS for fan-out. All env-var tunable. |

Operational quality:
- **Tagging**: every taggable resource gets Project / Component / Environment / ManagedBy / Repository tags via CDK propagation. Cost-allocation-tag activation procedure documented.
- **Logging**: 6 named CloudWatch log groups + Step Functions traces (level=ALL + X-Ray). All ephemeral EC2 logs survive instance termination.
- **Migration playbook**: `infra/aws/scripts/migrate-from-local.sh` uploads local lca.db, builds + pushes Lambda image, dumps + uploads local Postgres in one command. Skips the expensive cloud-side ingest on first deploy.
- **Cost transparency**: each budget cap reasoned, anomaly detector tuned to $5 minimum impact.

#### Outcomes

- All 16 default + 6 ranking + 6 archive + 4 compare = **~250 route types** rendered statically or near-statically.
- Lighthouse-friendly: prerendered HTML, hashed asset paths, CDN-ready.
- Quarterly rebuild = `./scripts/release.sh` (one command, ~5 min) on the VPS path, or an EventBridge-driven Step Functions execution on the AWS path.
- Dark mode + sortable tables + zebra striping + dark-themed Recharts tooltips = polished UX comparable to commercial competitors (Djinni, OnlyGenius were the visual reference points).

#### Defence story for this layer

> *The pipeline (Steps 1–6) makes the corpus normalised. The website
> (Step 7) makes the corpus legible to the public, monetisable, and
> deployable. Both halves are intentionally decoupled so the data side
> can move at quarterly cadence while the web side can deploy on code
> changes without touching Postgres.*

---

## Technical Summary

| Layer | Completeness | Notes |
|---|---|---|
| **Node.js ingestion pipeline** | **100 %** | All six years (3.83 M records, 24 XLSX files) ingested cleanly via SAX streaming + `pg-copy-streams`, 0 failed jobs |
| **Python NLP enrichment** | **97 %** | Stages 0/1/2 run inline and processed 3.65 M records (95.3 % coverage) with 0 errors. Stage 3 LLM is in code but unrun at scale (181 K residue × Mac CPU is uneconomical — needs GPU). All three entity-resolution layers wired in; the full-cascade backfill (Layer 1→2→3 + UPSERT) drained `unresolved_employers` to zero, ending at 146,206 canonicals and 99.47 % LCA canonical coverage. |
| **Internal analytics dashboard** | **100 %** | `apps/analytics-ui` — ten persona pages, 22 matviews, sub-second paint. Admin/internal facing. |
| **Public website (Analytics 2.0)** | **100 %** | `apps/analytics-web` — Next.js 15, ~250 routes, dark mode, sortable tables, charts, compare, archives, MDX articles, LLM summary scaffolding, AdSense + B2B API. See §Step 7. |
| **Infrastructure & DevOps** | **98 %** | Docker stack with pgvector, Redis, ingestor, nlp-worker, operator-ui, analytics-ui, analytics-web all healthy. AWS CDK (4 stacks) ready to deploy; logging + tagging + budgets in place. GitHub Actions ships analytics-web end-to-end. Still missing automated tests. |
| **Documentation** | **100 %** | README + this status file + `DEPLOY.md` (production playbook) + `infra/aws/README.md` (CDK reference) + `project_notes/` (full evolution narratives for SOC classifier, entity resolution, analytics dashboard). |

---

## Detailed Component Status

### 100% Complete

| Component | Path | Description |
|---|---|---|
| **Database Library** | `packages/db-lib` | Singleton PG pool, `pg-copy-streams` bulk COPY, idempotent `ensureSchema()`, partitioned tables, GIN + expression indexes, all NLP tables incl. new `employer_soc_consensus` |
| **Ingestor** | `apps/ingestor` | BullMQ worker: XLSX streaming via `xlstream`, UUID-tagged records (`_nlp_id`), enriched NLP payload (FEIN, state, city), batch flushing, ≤250 MB memory cap |
| **Harvester** | `apps/harvester` | Scrapes DOL site for new XLSX files, dedup via `harvested_files` table |
| **CLI Tool** | `apps/cli-tool` | `db:init`, `db:reset`, `db:status`, `seed`, `queue:stats`, `queue:drain` |
| **Infrastructure** | `docker-compose.yml` | `pgvector/pgvector:pg16`, Redis 7, nlp-worker, ingestion-worker — all healthy |
| **Pydantic Models** | `.../models.py` | `RecordItem`, `NlpJobPayload`, `SocResult` (now with `soc_source`, `review_reason`) |
| **DMTF Loader** | `.../dmtf_loader.py` | Downloads / parses BLS Direct Match Title File, auto-detects column layouts, bulk-upserts into `soc_aliases` |
| **SOC Classifier — Stage 0** | `.../soc_classifier.py` | New: per-employer consensus lookup via `employer_soc_consensus` (FEIN + normalized title). Runs **before** Stage 1. |
| **SOC Classifier — Stage 1** | `.../soc_classifier.py` | DMTF / bootstrap exact-match via `soc_aliases`; ~1.0 confidence on hit |
| **SOC Classifier — Stage 2** | `.../soc_classifier.py` | Sentence-transformer (`all-MiniLM-L6-v2`) semantic retrieval; cosine argmax with 0.7 confidence gate |
| **SOC Classifier — Stage 3 (LLM)** | `.../llm_classifier.py`, `.../reclassify_quarantine.py` | LLM picks from top-K Stage 2 candidates. Backends: Ollama (local Llama 3.1 8B) or Anthropic API. Includes built-in short-title gate that re-routes literal-string risks to HITL. |
| **Cross-employer alias bootstrap** | `.../alias_bootstrap.py` | Mines consensus `(JOB_TITLE, SOC_CODE)` pairs from `lca_records` into `soc_aliases` |
| **Per-employer consensus refresh** | `.../employer_consensus.py` | New: rebuilds `employer_soc_consensus` from `lca_records` aggregations |
| **Entity Resolution — Layer 1** | `.../entity_resolution.py` | FEIN deterministic match; populates `canonical_employers`. Carries 100 % of FY2024+FY2025 traffic; dead on FY2020-FY2023 (DOL data quirk). |
| **Entity Resolution — Layer 2** | `.../entity_resolution.py` | `pg_trgm` similarity, blocked by `employer_state`. GIN trigram filter for recall + Python precision gate. |
| **Entity Resolution — Layer 3** | `.../entity_resolution.py` | `pgvector` HNSW cosine over 384-dim sentence-transformer embeddings of `canonical_name`. Encoder shared with `SocClassifier` (no duplicate model load). |
| **Employer embedder** | `.../employer_embedder.py` | Encodes all `canonical_employers.canonical_name` into `employer_embeddings`. Idempotent. Run as `pnpm employers:embed`. Bulk path used after the initial Layer-1 explosion (92,289 vectors in 7m 27s); the full-cascade backfill encodes new canonicals inline as they are inserted (added 53,917 vectors during its ~4 h 39 min run). |
| **Auto-embed sweep (post-ingest)** | `.../entity_resolution.py::embed_pending`, `.../worker.py` | NLP worker runs an idempotent sweep after every batch (and once at startup) over canonicals lacking a vector. Reuses the encoder already loaded for Stage 2 SOC / Layer 3 — adds ~0 ms when nothing is pending. Covers canonicals from all three creation sites (worker FEIN insert, `backfill-canonical-full`, operator-ui `createCanonicalAndMerge`). Non-blocking `pg_try_advisory_lock` keeps concurrent workers from double-encoding. Disable with `NLP_AUTO_EMBED=0`; tune burst via `NLP_AUTO_EMBED_MAX_ROWS`. Makes manual `employers:embed` runs unnecessary in steady state. |
| **Canonical-id backfill (Layer 1 only)** | `.../backfill_canonical_ids.py` | Keyset-paginated CLI that resolves `canonical_employer_id` for orphan `lca_records` via FEIN-only lookup. Idempotent. Run as `pnpm canonical:backfill`. Best for the quick post-ingest sweep on FEIN-having records. |
| **Canonical-id full-cascade backfill** | `.../backfill_canonical_full.py` | New (2026-05-12, executed same day): full Layer 1/2/3 cascade against `staging.unresolved_employers`. Inserts new `canonical_employers` rows + embeddings on miss. Bulk-updates matching `lca_records` via the new composite expression index. Per-batch encoder calls + `enable_seqscan = off` for ~6× speedup over per-row writes. **Full run (157,612 entries, ~ 4 h 39 min): drained `unresolved_employers` to zero, inserted 53,917 new canonicals (and embeddings).** Run as `pnpm canonical:backfill-full`. |
| **Unresolved-employers queue** | `staging.unresolved_employers` + `worker._write_unresolved` | Aggregated UPSERT queue for records missed by all three layers. Drained to **0** open on 2026-05-12 by the full-cascade backfill (all 157,612 entries resolved either to an existing canonical or to a freshly-inserted one). |
| **NLP Worker** | `.../worker.py` | Async Redis consumer; runs SOC pipeline + 3-layer entity resolution; writes `soc_source`, `requires_review`, `review_reason`, `canonical_employer_id`; UPSERTs misses into `staging.unresolved_employers`. |
| **Reclassify-quarantine** | `.../reclassify_quarantine.py` | LLM-on-residual drain. Now also calls `resolve_fein` inline so quarantine drains never leave `canonical_employer_id` unset. |
| **Operator HITL UI** | `apps/operator-ui` | New: Fastify + EJS web app on port 8080. Walks all three review queues with list / inspect / accept / override / merge / reject actions. Single shared password (`OPERATOR_PASSWORD`) + signed-cookie session (`SESSION_SECRET`). Reuses `@lca/db-lib` pool. Unresolved-employer merges run a transactional `lca_records` backfill. Ships as Docker Compose service `operator-ui`. |
| **Internal analytics dashboard** | `apps/analytics-ui` | Fastify + EJS + Chart.js web app on port 8081, no auth. Ten persona pages over the canonicalised corpus, backed by 22 matviews + 1 plain view in `analytics.*` schema (~55 MB total). Page paint 16-552 ms cold / 7-117 ms warm. Bootstrap once via `pnpm analytics:bootstrap-views`; refresh after data changes via `pnpm analytics:refresh-views`. Full walkthrough in `project_notes/analytics_ui.md`. |
| **Public website (Analytics 2.0)** | `apps/analytics-web` | Shipped 2026-05-14 → 2026-05-20, **entity-explorer pattern + interactive choropleth added 2026-05-26**: Next.js 15 + Tailwind 4 + shadcn/ui + Geist + dark mode. ~250 prerendered routes (4 entity types × top-N + 6 ranking + 6 archive + 4 compare + home + search + API docs). All four index pages (`/employer`, `/occupation`, `/state`, `/sector`) share a KPI strip + biggest-share-movers chart + live search + sortable table. `/state` adds an interactive Albers choropleth (USPS labels, leader callouts, hover-driven side panel), Census region chips, and an absolute-vs-per-100k toggle. Reads a baked-in SQLite snapshot, never touches Postgres at runtime. Standalone Docker output for VPS or Lambda. Built quarterly from `analytics.*` matviews via `pnpm --filter analytics-web build:sqlite`. Full feature list in §Step 7. |
| **SQLite snapshot builder** | `apps/analytics-web/scripts/build-sqlite.ts` | Idempotent: reads top-N from Postgres matviews, writes a fresh `data/lca.db` (~0.4 MB), copies to `data/archives/<YYYY-qN>.lca.db`, computes 301 redirects for entities that dropped out since last build, disambiguates same-canonical-name entities (Amazon WA vs Amazon VA), persists new canonicals' embeddings. Skip-if-unchanged via `data_hash`. |
| **LLM summary generator** | `apps/analytics-web/scripts/generate-summaries.ts`, `lib/llm/*` | Provider-agnostic LLM abstraction (stub/anthropic/openai/local). Generates 141 entity summaries with SHA-256 skip-if-unchanged. ~$1 with Claude Sonnet, ~$0.05 with GPT-4o-mini. Currently shipping stub placeholders; populate `LLM_API_KEY` to swap in real prose. |
| **B2B Data API** | `apps/analytics-web/app/api/v1/*`, `apps/analytics-web/lib/keys-db.ts`, `lib/api/auth.ts` | Bearer + X-API-Key auth, SHA-256 hashed keys (`lcak_` prefix) in a separate `keys.db` volume-mount SQLite, in-memory rolling 24h rate limiter with three tiers (free 100, pro 10k, enterprise 1M req/day), API docs page at `/api/docs`. |
| **Production playbook** | `DEPLOY.md`, `scripts/release.sh`, `scripts/smoke-test.sh`, `.github/workflows/build-and-deploy.yml` | ~1000-line operations runbook: architecture diagrams, five lifecycles (quarterly data / code / LLM summaries / API keys / MDX articles), canonical 5-step rebuild, three deployment topologies, incident playbooks, monitoring, security. Helper scripts auto-tag rollback images and smoke-test 21 routes. GitHub Actions workflow ships the analytics-web app end-to-end. **Matview safety check** *(added 2026-05-26)*: `release.sh` diffs declared matviews in `analytics_views.sql` against `pg_matviews` and refuses to continue when any are missing — points the operator at `--rebuild-views`. Caught a class of "new matview silently skipped" failure that bit us on 2026-05-26. |
| **AWS-native deployment** | `infra/aws/` | CDK in TypeScript: four stacks (Shared, DataPipeline, Serve, Budgets). EventBridge → Lambda DOL-checker → Step Functions → ephemeral EC2 → builds + pushes Lambda Container Image → updates serving function → self-terminates. CloudFront + Lambda Web Adapter for serving. CloudWatch Agent + Docker awslogs driver for log shipping. Five budgets + Cost Anomaly Detection for billing protection. Cost-allocation tags + project-wide tagging via CDK propagation. `scripts/migrate-from-local.sh` skips first-build cloud ingest by uploading local artefacts directly. ~$3-6/mo steady-state. Full walkthrough in `infra/aws/README.md`. |
| **Documentation** | `README.md`, `PROJECT_STATUS.md`, `DEPLOY.md`, `infra/aws/README.md`, `project_notes/` | Architecture, status, production playbook, AWS CDK reference, plus full evolution narratives for the SOC classifier (`soc_classifier_evolution.md`), the entity-resolution cascade (`entity_resolution_evolution.md`), and the analytics dashboard (`analytics_ui.md`). |

### Not Yet Implemented

| Item | Notes |
|---|---|
| **BERT fine-tuning pipeline** | **Tested and rejected** — see `project_notes/soc_classifier_evolution.md`. Fine-tuned `bert-base-uncased` on 49 K bootstrap labels lost to Stage 2 retrieval by 11 pp exact / 3 pp major. Documented as a thesis finding. |
| **Stage 3 LLM reclassify at scale** | Code exists; running against 181,839 quarantined records needs batched-LLM mode + GPU (~5–10 h on A10G/L4 vs ~250 h on Mac CPU). |
| **Real LLM summaries** | Provider abstraction + generator script in place; currently shipping stub placeholders. Set `LLM_PROVIDER=anthropic` + `LLM_API_KEY=sk-ant-...` + `pnpm --filter analytics-web build:summaries`. Cost ~$1 with Claude Sonnet. |
| **AdSense slot configuration** | `ADSENSE_CLIENT_ID` + `ADSENSE_SLOTS` env vars unset → renders as transparent placeholders. Wire up a real AdSense account post-launch. |
| **3+ entity comparison** | Compare pages designed for arity ≥ 2 (catch-all `[...slugs]` routes); current UI surfaces 2-up only. ComparePicker + CompareSwapper carry the chip rail + search; extending to 3-4 columns is a UI tweak in CompareSwapper, not a routing change. |
| **Tests (web app + pipeline)** | No unit tests in any workspace. Manual smoke test (`scripts/smoke-test.sh`) exercises 21 critical routes. |
| **CI/CD for the data pipeline** | The analytics-web app has GH Actions (`build-and-deploy.yml`) and the Python `nlp-engine` has smoke tests (`nlp-engine-smoke.yml`, added 2026-05-25). The Node ingestor / harvester still have no workflow — they're a thin wrapper around `xlstream` + `pg-copy-streams` and would mainly benefit from a typecheck step. |
