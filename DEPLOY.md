# Deployment Playbook

This document is the operational source of truth for the **H1B Report** analytics web app (`apps/analytics-web`). It covers the architecture, every lifecycle (data, code, summaries, API keys, articles), the canonical build pipeline, deployment options, and a runbook for routine operations and incidents.

Audience: anyone responsible for shipping new code or new data to production.

---

## Contents

1. [TL;DR](#1-tldr)
2. [Architecture at a glance](#2-architecture-at-a-glance)
3. [Lifecycles](#3-lifecycles)
   - [3.1 Quarterly data lifecycle](#31-quarterly-data-lifecycle)
   - [3.2 Code lifecycle](#32-code-lifecycle)
   - [3.3 LLM summary lifecycle](#33-llm-summary-lifecycle)
   - [3.4 B2B API key lifecycle](#34-b2b-api-key-lifecycle)
   - [3.5 MDX article overlay lifecycle](#35-mdx-article-overlay-lifecycle)
4. [The canonical 5-step rebuild](#4-the-canonical-5-step-rebuild)
5. [Deployment topologies](#5-deployment-topologies)
6. [Operations runbook](#6-operations-runbook)
7. [Monitoring & health](#7-monitoring--health)
8. [Security & secrets](#8-security--secrets)
9. [Pre-deploy checklist](#9-pre-deploy-checklist)
10. [Appendix A — `release.sh` helper](#appendix-a--releasesh-helper)
11. [Appendix B — GitHub Actions workflow](#appendix-b--github-actions-workflow)
12. [Appendix C — Nginx reverse proxy](#appendix-c--nginx-reverse-proxy)
13. [Appendix D — systemd auto-refresh timer](#appendix-d--systemd-auto-refresh-timer)

---

## 1. TL;DR

The website is **statically generated from a baked-in SQLite snapshot**. It does not talk to Postgres at runtime. Updating data = rebuilding the SQLite file = rebuilding the Docker image = redeploying the container.

To ship a new quarter of DOL data once your Postgres matviews are fresh:

```bash
pnpm --filter analytics-web build:sqlite       # ~10s   — Postgres → lca.db
pnpm --filter analytics-web build:summaries    # ~5 min — LLM call per entity (optional, ~$1)
docker compose build analytics-web             # ~60s   — Next.js static build + image bake
docker compose up -d analytics-web             # ~5s    — rolling restart
```

Or use the helper: `./scripts/release.sh` (see [Appendix A](#appendix-a--releasesh-helper)).

To ship a code-only change (no data refresh), skip the first two commands.

---

## 2. Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│ BUILD-TIME (your laptop / CI runner)                                    │
│                                                                         │
│  ┌──────────────┐  refresh   ┌────────────────┐  build:sqlite  ┌──────┐ │
│  │ DOL XLSX     │ ──────────►│ Postgres 16    │ ──────────────►│lca.db│ │
│  │ (quarterly)  │  ingestor  │ analytics.*    │   (TS script)  │~0.4MB│ │
│  └──────────────┘            │ matviews       │                └──┬───┘ │
│                              └────────────────┘                   │     │
│                                                                   ▼     │
│                                          ┌────────────────────────────┐ │
│                                          │ Next.js standalone build   │ │
│                                          │  • Static HTML (~150 pages)│ │
│                                          │  • Client JS bundles       │ │
│                                          │  • Sitemap + OG images     │ │
│                                          └─────────────┬──────────────┘ │
│                                                        ▼                │
│                                          ┌────────────────────────────┐ │
│                                          │ Docker image (~376 MB)     │ │
│                                          │ • lca.db baked in          │ │
│                                          │ • Next.js standalone       │ │
│                                          └─────────────┬──────────────┘ │
└────────────────────────────────────────────────────────│────────────────┘
                                                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ RUNTIME (VPS or container host)                                         │
│                                                                         │
│  ┌─────────────────────────────────┐                                    │
│  │ lca_analytics_web container     │  ← only this runs in prod          │
│  │ Next.js standalone, port 3000   │                                    │
│  │  • Serves static HTML           │                                    │
│  │  • SQLite reads for /search,    │                                    │
│  │    /api/v1, /compare on-demand  │                                    │
│  │  • API keys.db on volume mount  │                                    │
│  └─────────────────────────────────┘                                    │
│             ▲                                                           │
│             │ optional reverse proxy / CDN                              │
│  ┌──────────┴──────────┐                                                │
│  │ Cloudflare / Nginx  │                                                │
│  │ TLS + edge cache    │                                                │
│  └─────────────────────┘                                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### What runs in production vs build-only

| Component | Role | Prod? |
|---|---|---|
| `apps/analytics-web` | Next.js website (static + small dynamic surface) | ✅ |
| Postgres | Source of truth for normalised LCA records | ❌ build-only |
| Redis + BullMQ | Job orchestration for ingestion | ❌ build-only |
| `apps/ingestor` | Streams + validates + COPYs XLSX files | ❌ offline |
| `apps/harvester` | Scrapes DOL quarterly releases | ❌ offline |
| `apps/cli-tool` | DB init, archive seeding, quarantine reprocess | ❌ admin only |
| `packages/nlp-engine` | Python SOC classifier + entity resolver | ❌ offline |

The production VPS only needs Docker and the `lca_analytics_web` image. Postgres, Redis and the ingestion pipeline live on your build / data-ops machine, completely off the public network.

### Why this design

- **No DB credentials on the web server.** Compromising the web host gives no path into Postgres.
- **No DB latency in the request path.** Every entity / list / ranking page is HTML served from disk; SQLite handles a few small reads for search / compare / API only.
- **Trivially horizontally scalable.** The image is self-contained; multiply containers behind a load balancer with zero coordination.
- **Atomic data swap.** A new image is a new immutable artifact. Rollback = redeploy the previous tag.

### Trade-offs we accepted

- Quarterly cadence is the natural refresh rate. Pushing data more often than daily means rebuilding the image more often than daily.
- The launch slice covers the top 50 employers / 30 occupations / 30 states / 30 sectors. Long-tail entities aren't in the SQLite snapshot. Tuneable via `TOP_EMPLOYERS` / `TOP_OCCUPATIONS` / `TOP_STATES` / `TOP_SECTORS` env vars when building.

---

## 3. Lifecycles

### 3.1 Quarterly data lifecycle

This is the dominant operational rhythm. DOL publishes one LCA release per fiscal quarter (typically a few weeks after quarter-end).

```
DOL XLSX release  ─► Ingestor  ─► Postgres        ─► build:sqlite  ─► lca.db   ─► Image bake ─► Deploy
   (quarterly)        SAX+COPY    canonical +         pulls top-N      static       Docker        rolling
                       quarantine   matviews refresh   aggregates       Next.js      build         restart
   Day 0              Day 0-1      Day 1-2            Day 2 (10s)      Day 2 (60s)  Day 2 (5s)    Day 2
```

**Stage 1 — Harvest**: `apps/harvester` cron job watches the DOL Office of Foreign Labor Certification page, downloads new releases to a shared volume, and enqueues BullMQ jobs.

**Stage 2 — Ingest**: `apps/ingestor` workers stream-parse XLSX via SAX (`xlstream`), validate each row with Zod, route invalid rows to `staging.quarantine_records`, and COPY good rows into the partitioned `lca_records` table.

**Stage 3 — Normalise**: the Python `nlp-engine` runs SOC classification (DMTF exact match → BERT fallback) and 3-layer entity resolution (FEIN → trigram → embeddings) on the new records. Writes back `soc_code` and `canonical_employer_id`. Low-confidence rows flag `requires_review=True` and route to quarantine.

**Stage 4 — Refresh matviews**:

```bash
pnpm --filter @lca/cli analytics:refresh-views
```

This refreshes `analytics.mv_employer_outcomes`, `mv_naics_sector_summary`, `mv_naics_sector_by_year`, `mv_wage_by_soc_*`, `mv_top_employers_by_soc`, `mv_state_concentration`, etc. (see `apps/analytics-ui/db/analytics_views.sql` for the full list).

**Stage 5 — Build SQLite snapshot**:

```bash
pnpm --filter analytics-web build:sqlite
```

`scripts/build-sqlite.ts` connects to Postgres, pulls the top-N entities from each matview, computes cross-references (top SOCs per employer, top employers per state, etc.), disambiguates same-name canonical entities (Amazon WA vs Amazon VA), and writes a fresh `apps/analytics-web/data/lca.db`. Idempotent — drops and recreates the file.

**Stage 6 — Generate LLM summaries** (optional, see §3.3).

**Stage 7 — Build + deploy image** (see §4 and §5).

### 3.2 Code lifecycle

Code changes follow a separate rhythm — typically several deploys per quarter, more during active development.

```
git push  ─► CI tests   ─► Docker build  ─► Image registry  ─► Deploy        ─► Smoke test
              (pnpm test,   (~60s)            (push)             (compose up)    (curl health)
               typecheck)
```

CI runs typecheck + tests on every push. On merges to `main`, CI builds and pushes the image, then triggers a deploy hook on the VPS. See [Appendix B](#appendix-b--github-actions-workflow) for a sample workflow.

The site has **no database migration concept** at runtime — every prod release is a complete artifact. The SQLite schema is defined in `apps/analytics-web/lib/schema.ts` and applied fresh each `build:sqlite` run, so schema changes ship with code.

### 3.3 LLM summary lifecycle

Per-entity prose summaries live in the `entity_summary` table in `lca.db`. They're cached with a SHA-256 `data_hash` so unchanged entities skip the LLM call on rebuild.

```
build:summaries  ─► For each of 141 entities:
                       ├─► Compute data_hash from the entity's structured data
                       ├─► If unchanged from last run → skip (free, ~0ms)
                       └─► Else → call LLM → write summary_md + new hash
```

Run after `build:sqlite`:

```bash
LLM_PROVIDER=anthropic \
LLM_API_KEY=sk-ant-... \
LLM_CONCURRENCY=4 \
  pnpm --filter analytics-web build:summaries
```

Providers (selected via `LLM_PROVIDER`):

| Provider | Cost (141 entities) | Model |
|---|---|---|
| `stub` (default) | $0 | placeholder text |
| `anthropic` | ~$1 | claude-sonnet-4-6 |
| `openai` | ~$0.05 | gpt-4o-mini |
| `local` | $0 (own GPU) | vLLM endpoint |

To force a full regeneration (e.g. you tweaked the system prompt and want new prose for all rows):

```bash
sqlite3 apps/analytics-web/data/lca.db "DELETE FROM entity_summary"
pnpm --filter analytics-web build:summaries
```

Quality review: spot-check 5–10 random entities after each regeneration. Watch for hallucinated facts (the prompt explicitly says "only reference figures present in the structured data payload" but verify).

### 3.4 B2B API key lifecycle

API keys live in a **separate SQLite file** (`keys.db`) on a volume mount, so they survive image rebuilds. Keys are stored as SHA-256 hashes; we never persist the cleartext.

```
Customer signup → admin issues key → key in keys.db (hashed) → customer uses it in headers → rate-limited per tier
```

To issue a key (current state: by hand, no admin UI):

```bash
# On the VPS, inside the container or against the mounted volume
docker compose exec analytics-web node -e "
  import { issueApiKey } from './apps/analytics-web/lib/keys-db.js';
  console.log(issueApiKey({ tier: 'pro', label: 'acme-corp' }));
"
# Prints: lcak_xxxxxxxxxx — store this safely, the customer can't see it again.
```

Rate limits per tier (in `lib/api/auth.ts` and shown in `/api/docs`):
- Free: 100 requests/day
- Pro: 10,000 requests/day
- Enterprise: 1,000,000 requests/day

The rate limiter is in-memory + rolling 24h. For a multi-container deploy you'd want Redis-backed limits, but at MVP scale a single container is fine.

To revoke:

```sql
DELETE FROM api_key WHERE label = 'acme-corp';
-- or
UPDATE api_key SET revoked_at = unixepoch() WHERE label = 'acme-corp';
```

### 3.5 MDX article overlay lifecycle

Editorial content (per-entity articles) lives as MDX files in `apps/analytics-web/content/`, organised by entity kind and slug:

```
content/
  employer/
    cognizant-technology-solutions-us-corp.mdx
    ...
  occupation/
    software-developers-15-1252.mdx
  state/
    california-ca.mdx
  sector/
    professional-scientific-and-technical-services-54.mdx
```

These are optional — the entity page works fine without one. When present, the article renders below the LLM summary inside an `.article` block.

Lifecycle:
1. Author writes an MDX file (committed to git, code review applies)
2. `git push` → CI → image rebuild bundles the new content
3. Deploy → article appears on the entity page

No data-pipeline step. Articles are pure code commits.

---

## 4. The canonical 5-step rebuild

This is the procedure for every data refresh. Every step is idempotent.

### Step 1 — Refresh Postgres matviews

Required after new data lands in `lca_records`. Skip if your Postgres is already up to date.

```bash
pnpm --filter @lca/cli analytics:refresh-views
```

What it does: runs `REFRESH MATERIALIZED VIEW analytics.<view>` for every analytics matview, in dependency order.

Expected time: 1–15 min depending on dataset size.

Failure mode: usually a row-count mismatch or stale FK. Check `pg_stat_activity` for blocking queries; consider `REFRESH MATERIALIZED VIEW CONCURRENTLY` if a unique index exists.

### Step 2 — Build the SQLite snapshot

```bash
pnpm --filter analytics-web build:sqlite
```

What it does (`scripts/build-sqlite.ts`):
1. Reads `DATABASE_URL` from monorepo-root `.env`
2. Removes the existing `data/lca.db`
3. Applies `SCHEMA_SQL` from `lib/schema.ts` to a fresh file
4. Pulls top-N entities from `mv_employer_outcomes`, `mv_soc_summary`, `mv_filings_by_state`, `mv_naics_sector_summary`
5. Pulls cross-references (employer_top_soc, occupation_top_*, state_top_*, sector_top_*, *_yearly)
6. Disambiguates same-canonical_name entities by appending state code or last-4 of FEIN
7. `ANALYZE` for query planning

Expected time: ~10 seconds. Output file ~0.4 MB.

Tuning:

```bash
TOP_EMPLOYERS=100 TOP_OCCUPATIONS=50 pnpm --filter analytics-web build:sqlite
```

Failure mode: Postgres unreachable or wrong port. Check `docker compose ps` for `lca_db` and the `.env` `DATABASE_URL`.

### Step 3 — Regenerate LLM summaries

Optional. Skip if you're using the stub provider or if data hasn't changed significantly.

```bash
pnpm --filter analytics-web build:summaries
```

Reads `LLM_PROVIDER` + `LLM_API_KEY` from env. Skip-if-unchanged: only entities whose `data_hash` changed since the last run trigger an LLM call. Expected: most calls skip after a small data refresh.

Expected time: ~5 minutes for a full regeneration of 141 entities at concurrency=4. ~$1 with Claude Sonnet, ~$0.05 with GPT-4o-mini.

### Step 4 — Build the Docker image

```bash
docker compose build analytics-web
```

What it does (`apps/analytics-web/Dockerfile`):
1. **deps stage**: `pnpm install --frozen-lockfile` for the monorepo
2. **builder stage**: `pnpm --filter analytics-web build` — Next.js statically generates every page, sitemap, OG image, robots.txt. Reads the new `lca.db` baked into the source tree.
3. **runner stage**: alpine image, copies the `.next/standalone` output + `lca.db` + `public/` + chown to a non-root `nextjs` user. Mounts a writable `/keys` directory for `keys.db`.

Expected time: ~60s on a dev laptop, 2–4 min on a small VPS. Output image ~376 MB.

Failure mode: type errors or build errors in any page. The Next.js build is strict — broken type → broken image. CI should run `pnpm typecheck` before this step.

### Step 5 — Deploy

```bash
docker compose up -d analytics-web
```

Replaces the running container. Expect 3–5s of HTTP downtime as the old container drains and the new one starts listening on port 3000.

Verify:

```bash
curl -fsS http://localhost:3000/ -o /dev/null && echo "OK"
curl -fsS http://localhost:3000/employer/cognizant-technology-solutions-us-corp -o /dev/null && echo "Entity OK"
curl -fsS http://localhost:3000/api/v1/kpis -H "Authorization: Bearer $TEST_KEY" | jq .data
```

Failure mode: container exits immediately. Check `docker compose logs analytics-web --tail 50`. The most common cause is a missing `lca.db` in the image — confirm step 2 ran successfully.

---

## 5. Deployment topologies

### 5.1 Single VPS (recommended for MVP / ≤300k visits/mo)

```
Internet ──► VPS (Caddy/Nginx :443 → lca_analytics_web :3000)
```

Single $5–20/mo VPS (Hetzner CX21, DigitalOcean Basic, Linode 2 GB) handles 300k visits/month comfortably. SQLite reads are sub-ms, the Next.js standalone is small (~80 MB resident), and most pages are pre-rendered HTML served from disk.

Stack:
- Ubuntu 24.04 LTS (or Debian 12)
- Docker + docker-compose
- Caddy or Nginx for TLS + reverse proxy (see [Appendix C](#appendix-c--nginx-reverse-proxy))
- Optional: ufw firewall, restrict :3000 to localhost

### 5.2 VPS + Cloudflare CDN (recommended once traffic ramps)

```
Internet ──► Cloudflare edge ──► VPS (Nginx :443 → lca_analytics_web :3000)
                cache HTML            cache miss + dynamic routes
```

Cloudflare in front of the VPS gives:
- Edge caching of all static HTML pages (every entity / list / ranking page) — free tier is sufficient
- DDoS protection
- Origin shielding
- Free TLS certificate

Set Page Rules:
- `*/api/v1/*` — bypass cache
- `*/search*` — bypass cache (depends on query string)
- `*/compare/*` — cache 1 hour
- Everything else — cache 4 hours

At this stage your origin VPS sees only the dynamic routes; everything else is served from Cloudflare's edge.

### 5.3 Zero-downtime via blue/green

For zero HTTP downtime during deploys, run two containers and swap traffic:

```yaml
# docker-compose.yml
services:
  analytics-web-blue:
    image: lca-analytics-web:${BLUE_TAG}
    ports: ["3001:3000"]
  analytics-web-green:
    image: lca-analytics-web:${GREEN_TAG}
    ports: ["3002:3000"]
```

Then your reverse proxy upstream config swaps `:3001` ↔ `:3002` after the new container passes a health check. Connection drain on the old container, ~30s grace period, then stop it.

For a project at this scale the 3–5s downtime on a single-container deploy is fine. Add blue/green when SLA requires it.

---

## 6. Operations runbook

### Routine: Quarterly data refresh

**Trigger**: DOL publishes a new quarterly LCA release.

**Steps**:

```bash
# On your data-ops machine (or via SSH to a build host)
cd /path/to/lca-normalization-engine
git pull

# Ingest the new release (offline)
pnpm --filter @lca/cli seed --files-dir /data/dol/2026-Q1

# Run NLP / entity resolution (offline)
cd packages/nlp-engine && python -m nlp_engine.cli backfill

# Refresh matviews + rebuild snapshot + summaries + image
pnpm --filter @lca/cli analytics:refresh-views
pnpm --filter analytics-web build:sqlite
pnpm --filter analytics-web build:summaries     # optional
docker compose build analytics-web
docker compose up -d analytics-web

# Smoke test
./scripts/smoke-test.sh                          # see Appendix A
```

**Expected duration**: 1–4 hours including ingestion + NLP. The image build + deploy is ~5 minutes of that.

**Post-deploy**:
- Check sitemap reflects new data: `curl -s https://h1b.report/sitemap.xml | head -20`
- Spot-check a few entity pages
- Update PROJECT_STATUS.md with the new fiscal year window

### Routine: Code-only deploy (no data change)

**Steps**:

```bash
git pull
pnpm install                                      # if package.json changed
docker compose build analytics-web
docker compose up -d analytics-web
```

**Expected duration**: ~3 minutes total.

### Routine: Issue a new API key

```bash
docker compose exec analytics-web node \
  apps/analytics-web/scripts/issue-key.mjs \
  --tier=pro --label="acme-corp" --email="ops@acme.com"
# Outputs: lcak_xxxxxxxxxxxxxxx
```

Email the cleartext key to the customer. The DB only holds the SHA-256 hash; we cannot recover it later.

### Incident: Site returns 502 / unreachable

```bash
# 1. Is the container running?
docker compose ps analytics-web
# If "Exited" → restart attempt
docker compose up -d analytics-web

# 2. Logs in the last 5 minutes
docker compose logs analytics-web --since 5m --tail 100

# 3. Disk space (image bloat, ad-hoc keys.db growth)
df -h
docker system df

# 4. Memory pressure
docker stats analytics-web --no-stream
```

Most common cause: a previous deploy shipped a bad image. Rollback (see below).

### Incident: Need to rollback

```bash
# List recent images by tag
docker images lca-normalization-engine-analytics-web --format "table {{.Tag}}\t{{.CreatedSince}}"

# Roll back
docker tag lca-normalization-engine-analytics-web:rollback \
           lca-normalization-engine-analytics-web:latest
docker compose up -d analytics-web

# Verify
curl -fsS https://h1b.report/ -o /dev/null && echo "OK"
```

**Pre-deploy practice**: tag the previously-deployed image as `:rollback` before every deploy. The `release.sh` script in Appendix A does this.

### Incident: Database connection lost during build

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

Postgres is down or the URL is wrong.

```bash
docker compose ps lca_db                          # check container
docker compose logs lca_db --tail 50              # check Postgres logs
grep DATABASE_URL .env                             # verify host/port/password
```

The build script needs Postgres only — the production container does NOT. So a failed `build:sqlite` doesn't take down the running site; the old image keeps serving until you build a new one.

### Incident: Cloudflare cached a stale page

```bash
# In the Cloudflare dashboard:
# Caching → Configuration → Purge Everything

# Or via API:
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'
```

Better: include the build hash in `<link rel="canonical">` or rely on Cloudflare's auto-invalidation when the underlying file hash changes. Next.js fingerprints all static assets by default; HTML pages can be invalidated via `Cache-Tag` headers + Cloudflare Workers.

### Maintenance: Disk fill-up

```bash
# Old Docker images / build cache
docker system prune -af --filter "until=720h"     # >30 days old

# Postgres bloat (run on the data-ops host, not the web server)
psql -c "VACUUM FULL ANALYZE staging.raw_lca_data"
```

### Maintenance: Postgres backup

```bash
# Hot dump (daily cron on the data-ops host)
pg_dump --format=custom --compress=9 --no-owner --no-acl \
  -h localhost -U lca_user -d lca_db \
  -f /backup/lca_db-$(date +%Y%m%d).pgdump
```

The production VPS doesn't need backups — its source of truth is the Docker image + `keys.db` volume. Backup the volume:

```bash
docker run --rm -v lca_keys_data:/keys -v $(pwd):/out \
  alpine tar czf /out/keys-$(date +%Y%m%d).tgz -C /keys .
```

---

## 7. Monitoring & health

### Built-in checks

| Endpoint | Purpose |
|---|---|
| `/` | Should return 200 with the home page HTML |
| `/sitemap.xml` | Should return 200 with the current entity index |
| `/api/v1/kpis` (with valid key) | Should return live SQLite data |

A minimal external monitor:

```bash
# Uptime cron — every 5 minutes
*/5 * * * * curl -fsS https://h1b.report/ -o /dev/null || \
  curl -X POST "$ALERT_WEBHOOK" -d "site down"
```

### Container metrics

```bash
docker stats analytics-web --no-stream
# CPU < 5%, RSS < 200 MB under steady state — anything significantly higher
# means a slow query or a memory leak, worth investigating.
```

### Logs

The container writes Next.js + Node logs to stdout. Standard `docker compose logs analytics-web` captures them. For long-term retention pipe to syslog or a hosted log aggregator (Better Stack, Axiom, Datadog).

### What to alert on

| Signal | Severity | Action |
|---|---|---|
| `/` returns non-200 for >2 min | Critical | Page on-call, check `docker logs`, attempt restart |
| Container restart loop | Critical | Roll back to previous image |
| Disk >85% on web host | Warning | `docker system prune`, then deeper triage |
| Build job fails | Warning | Site keeps serving; investigate before next refresh |
| 5xx rate >1% over 10 min | Warning | Check logs for stack traces, common cause: SQLite locked or missing file |
| API rate-limit 429s spike | Info | Likely a customer hammering; verify against expected tier |

---

## 8. Security & secrets

### Where secrets live

| Secret | Where | Read by |
|---|---|---|
| `DATABASE_URL` | `.env` (monorepo root, **never committed**) | build:sqlite, build:summaries |
| `LLM_API_KEY` | `.env` or CI secret | build:summaries |
| `ADSENSE_CLIENT_ID` | container env var | runtime (analytics-web) |
| `API_KEYS_SIGNING` | (none — keys are SHA-256, no signing) | n/a |
| `CF_TOKEN` | CI secret | deploy step (purge cache) |

`.env` is in `.gitignore`. For CI, store these as repository secrets / environment variables. **No secret should ever ship inside the Docker image.**

### Production VPS hardening

```bash
ufw allow 22
ufw allow 80
ufw allow 443
ufw deny 3000           # only reverse proxy reaches the container
ufw deny 5432           # Postgres must not be public
ufw enable
```

### AdSense considerations

The site loads the AdSense script only if `ADSENSE_CLIENT_ID` is set in container env. For initial launch without an AdSense account: leave it unset and the `<ins>` tags render as transparent placeholders (no third-party scripts loaded). Easy to flip later.

### LLM data privacy

`scripts/generate-summaries.ts` sends structured aggregates (employer name, filing counts, percentages) to your chosen LLM provider. **No individual H-1B records or PII leave your system** — only the same aggregated stats that appear publicly on the site. Anthropic and OpenAI both offer data-retention controls that you should configure in their consoles.

---

## 9. Pre-deploy checklist

Before pushing to production, confirm:

- [ ] `pnpm typecheck` passes for all workspaces
- [ ] `docker compose build analytics-web` completes locally
- [ ] Local smoke test: `curl -fsS http://localhost:3000/` returns 200
- [ ] If data refresh: `lca.db` has the expected row counts
- [ ] If data refresh: spot-check 5 entity pages for sane values
- [ ] If summary refresh: read 5 random summaries for hallucinations
- [ ] Previous image tagged as `:rollback` (or `release.sh` did it for you)
- [ ] PROJECT_STATUS.md reflects what's changed in this deploy
- [ ] CHANGELOG.md updated if user-visible (optional)

---

## Appendix A — `release.sh` helper

Create `scripts/release.sh` at the repo root:

```bash
#!/usr/bin/env bash
set -euo pipefail

# release.sh — canonical rebuild + deploy for analytics-web.
# Usage:
#   ./scripts/release.sh                   # full rebuild (data + image)
#   ./scripts/release.sh --code-only       # skip SQLite + summaries
#   ./scripts/release.sh --skip-summaries  # rebuild data but keep existing summaries

CODE_ONLY=0
SKIP_SUMMARIES=0
for arg in "$@"; do
  case "$arg" in
    --code-only)      CODE_ONLY=1 ;;
    --skip-summaries) SKIP_SUMMARIES=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."
ROOT=$(pwd)

echo "▶ Pre-flight checks"
pnpm --filter analytics-web typecheck
echo "  ✓ Typecheck passed"

if [[ $CODE_ONLY -eq 0 ]]; then
  echo "▶ Step 1: Rebuilding lca.db from Postgres"
  pnpm --filter analytics-web build:sqlite

  if [[ $SKIP_SUMMARIES -eq 0 ]]; then
    echo "▶ Step 2: Regenerating LLM summaries"
    pnpm --filter analytics-web build:summaries
  fi
fi

echo "▶ Step 3: Tagging current image as :rollback"
if docker image inspect lca-normalization-engine-analytics-web:latest >/dev/null 2>&1; then
  docker tag lca-normalization-engine-analytics-web:latest \
             lca-normalization-engine-analytics-web:rollback
  echo "  ✓ Previous image tagged"
else
  echo "  ⚠  No previous :latest image — first release"
fi

echo "▶ Step 4: Building new image"
docker compose build analytics-web

echo "▶ Step 5: Deploying"
docker compose up -d analytics-web

echo "▶ Step 6: Smoke test"
sleep 3
for path in / /employer /occupation/software-developers-15-1252 /sitemap.xml; do
  code=$(curl -fsS -o /dev/null -w "%{http_code}" "http://localhost:3000${path}" || echo "FAIL")
  printf "  %-50s %s\n" "$path" "$code"
  [[ "$code" == "200" ]] || { echo "✗ Smoke test failed"; exit 1; }
done

echo "✓ Release complete"
```

Make it executable:

```bash
chmod +x scripts/release.sh
```

Usage:

```bash
./scripts/release.sh                # full quarterly refresh
./scripts/release.sh --code-only    # code-only deploy
```

---

## Appendix B — GitHub Actions workflow

Create `.github/workflows/build-and-deploy.yml`:

```yaml
name: Build and Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      refresh_data:
        description: 'Rebuild lca.db from Postgres'
        type: boolean
        default: false

jobs:
  typecheck:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter analytics-web typecheck

  build-data:
    needs: typecheck
    if: inputs.refresh_data == true
    runs-on: ubuntu-24.04
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: lca_user
          POSTGRES_PASSWORD: ${{ secrets.PG_PASSWORD }}
          POSTGRES_DB: lca_db
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Restore Postgres dump
        env:
          PGDUMP_URL: ${{ secrets.PGDUMP_URL }}
        run: |
          curl -fsSL "$PGDUMP_URL" | \
            pg_restore --no-owner --no-acl --clean --if-exists \
              -h localhost -U lca_user -d lca_db
      - name: Build SQLite
        env:
          DATABASE_URL: postgresql://lca_user:${{ secrets.PG_PASSWORD }}@localhost:5432/lca_db
        run: pnpm --filter analytics-web build:sqlite
      - name: Regenerate summaries
        env:
          LLM_PROVIDER: anthropic
          LLM_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: pnpm --filter analytics-web build:summaries
      - uses: actions/upload-artifact@v4
        with:
          name: lca-db
          path: apps/analytics-web/data/lca.db

  build-image:
    needs: [typecheck]
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - name: Download lca.db (if data refresh ran)
        uses: actions/download-artifact@v4
        if: inputs.refresh_data == true
        with:
          name: lca-db
          path: apps/analytics-web/data/
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/analytics-web/Dockerfile
          push: true
          tags: |
            ghcr.io/${{ github.repository }}/analytics-web:latest
            ghcr.io/${{ github.repository }}/analytics-web:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build-image
    runs-on: ubuntu-24.04
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.PROD_HOST }}
          username: ${{ secrets.PROD_USER }}
          key: ${{ secrets.PROD_SSH_KEY }}
          script: |
            set -euo pipefail
            cd /opt/lca

            # Tag current as rollback
            docker tag ghcr.io/${{ github.repository }}/analytics-web:latest \
                       ghcr.io/${{ github.repository }}/analytics-web:rollback || true

            # Pull new
            docker pull ghcr.io/${{ github.repository }}/analytics-web:latest

            # Restart
            docker compose up -d analytics-web

            # Smoke test
            sleep 5
            for path in / /employer /sitemap.xml; do
              curl -fsS -o /dev/null "http://localhost:3000$path"
            done
```

Required GitHub secrets:
- `PG_PASSWORD`, `PGDUMP_URL` (only if running data refresh in CI)
- `ANTHROPIC_API_KEY` (or per-provider equivalent)
- `PROD_HOST`, `PROD_USER`, `PROD_SSH_KEY` (deploy target)

Data refreshes in CI assume you've uploaded a Postgres dump to S3 / R2 nightly. For most projects, keep data refreshes manual (local) and use CI only for code deploys.

---

## Appendix C — Nginx reverse proxy

Save as `/etc/nginx/sites-available/h1b.report`:

```nginx
server {
    listen 80;
    server_name h1b.report www.h1b.report;
    return 301 https://h1b.report$request_uri;
}

server {
    listen 443 ssl http2;
    server_name www.h1b.report;
    ssl_certificate     /etc/letsencrypt/live/h1b.report/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/h1b.report/privkey.pem;
    return 301 https://h1b.report$request_uri;
}

server {
    listen 443 ssl http2;
    server_name h1b.report;

    ssl_certificate     /etc/letsencrypt/live/h1b.report/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/h1b.report/privkey.pem;

    # Compression
    gzip on;
    gzip_types text/plain text/css text/javascript application/javascript
               application/json application/xml image/svg+xml;
    gzip_min_length 1024;

    # Modest local cache for static asset hashes (Next.js fingerprints them)
    location /_next/static/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_cache_valid 200 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # API gets no caching (response-level Cache-Control handles it)
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    # Everything else
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }
}
```

Enable:

```bash
sudo ln -s /etc/nginx/sites-available/h1b.report /etc/nginx/sites-enabled/
sudo certbot --nginx -d h1b.report -d www.h1b.report
sudo nginx -t && sudo systemctl reload nginx
```

---

## Appendix D — systemd auto-refresh timer

For unattended quarterly data refreshes (only run this on a host with Postgres access):

`/etc/systemd/system/lca-refresh.service`:

```ini
[Unit]
Description=Quarterly LCA data refresh
After=network-online.target

[Service]
Type=oneshot
User=lca-ops
WorkingDirectory=/opt/lca-normalization-engine
EnvironmentFile=/opt/lca-normalization-engine/.env
ExecStart=/opt/lca-normalization-engine/scripts/release.sh
StandardOutput=append:/var/log/lca-refresh.log
StandardError=append:/var/log/lca-refresh.log
```

`/etc/systemd/system/lca-refresh.timer`:

```ini
[Unit]
Description=Trigger LCA refresh on the 5th of every fourth month (Feb/May/Aug/Nov)

[Timer]
OnCalendar=*-02,05,08,11-05 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lca-refresh.timer
sudo systemctl list-timers | grep lca
```

The cadence (`Feb/May/Aug/Nov` on the 5th) tracks DOL's typical quarterly release delay. Adjust to match observed release dates.

---

## Versioning & changelog

Tag releases in git when shipping data refreshes:

```bash
git tag -a "data-2026-q1" -m "FY2026 Q1 DOL refresh"
git push origin data-2026-q1
```

This makes it trivial to find the source-tree state behind any production deploy.

---

**Last updated**: 2026-05-20. Living document — edit whenever an operation pattern changes.
