# analytics-ui

Read-only, public-facing analytics dashboard over the canonicalised LCA corpus.

## What it shows

Four persona pages, each answering questions that *that user* actually asks:

| Page | Audience | What it shows |
|---|---|---|
| `/journalist` | Public, reporters | Top H-1B sponsors (canonicalised), worksite-state distribution, year-over-year filing volume, top occupations |
| `/jobseeker`  | Career researchers | Wage percentiles (P25/P50/P75) by SOC, interactive SOC + state + city lookup, top employers per SOC, wage trend over time |
| `/policy`     | Labor economists | Filings per year, median wage per year, top-state share over time (stacked), wage-growth trajectory for top 5 SOCs, case outcome breakdown |
| `/academic`   | Thesis examiner | Coverage KPIs, classification source mix (DMTF/semantic/consensus/operator), Stage-2 confidence histogram, entity-resolution layer outcomes, top 10 canonical employers |

## Why materialized views

The lca_records table is 3.83 M rows of JSONB. Naive `count(*)` takes ~75 s
cold-cache. Each persona page would have spawned 4-5 such queries in
parallel — unworkable.

Solution: every aggregation panel is backed by a `analytics.*`
materialized view, populated once after data ingest. Page paint drops from
"minutes" to "< 200 ms" because each view is a tiny pre-aggregated table.

DDL lives in `db/analytics_views.sql`. Bootstrap once after a re-ingest:

```bash
DATABASE_URL=... pnpm analytics:bootstrap-views
```

After any backfill (canonical, SOC, ER) or new ingest, refresh:

```bash
DATABASE_URL=... pnpm analytics:refresh-views
```

The only non-matview query is `wageLookup` (Job Seeker's interactive SOC +
state + city percentile lookup), because the filter set is open. It still
hits the partial soc_code index plus the composite name+state index and
typically finishes in 1-3 s.

## Run

```bash
# Local dev (hot reload)
DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db pnpm analytics:dev

# Docker
docker compose up -d analytics-ui          # http://localhost:8081
```

## Configuration

| Env var              | Default               | Notes |
|----------------------|-----------------------|-------|
| `DATABASE_URL`       | required              | Read-only is sufficient |
| `ANALYTICS_UI_PORT`  | `8081`                | Compose maps `${ANALYTICS_UI_PORT}:8081` |
| `ANALYTICS_UI_HOST`  | `0.0.0.0`             | |
| `LOG_LEVEL`          | `info`                | Pino |

No auth — data is public DOL disclosure. If exposed outside localhost,
front with a reverse proxy.

## Files

```
apps/analytics-ui/
├── index.js                        # Fastify entry
├── package.json
├── Dockerfile
├── db/
│   ├── analytics_views.sql         # DDL: every analytics.* materialized view
│   └── refresh_views.sql           # REFRESH MATERIALIZED VIEW × N
├── lib/
│   └── queries.js                  # All read queries, mostly matview lookups
├── routes/
│   ├── home.js
│   ├── journalist.js
│   ├── jobseeker.js
│   ├── policy.js
│   └── academic.js
├── views/
│   ├── home.ejs
│   ├── journalist.ejs
│   ├── jobseeker.ejs
│   ├── policy.ejs
│   ├── academic.ejs
│   └── partials/{header,footer,panel}.ejs
└── public/
    └── style.css
```
