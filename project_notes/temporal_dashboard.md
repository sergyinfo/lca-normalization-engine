# Temporal Dashboard — design notes

**Date:** 2026-06-07
**App:** `apps/analytics-web` (Next.js 15 App Router, the public site at `h1b.report`)
**Feature:** fiscal-year filtering across the homepage and entity pages
**Backed by:** a read-only SQLite snapshot (`data/lca.db`) built from the Postgres
`analytics.*` materialized views; **no runtime database.**

> This note documents *why* the dashboard grew a time dimension once the corpus
> reached FY2010–2025, and the architectural decision that made it possible
> without giving up static generation (the site's core performance + SEO bet).
> It complements `analytics_ui.md`, which covers the older internal Fastify/EJS
> dashboard over the FY2020–2025 subset.

---

## Why this exists

For most of the project's life the public corpus was FY2020–2025 — six years.
A "median wage" or "filings" headline averaged over six recent, broadly similar
years is a defensible summary. Once the all-years backfill landed (FY2010–2025,
**9.12M rows**, ~16 years), that stopped being true:

- A wage **averaged over 16 years** mixes a 2010 labor market with a 2025 one.
  Nominal wages roughly doubled across that span; the average is an artifact, not
  an answer.
- Filing **volume** grew by an order of magnitude; an all-time "top occupations"
  table is dominated by the recent, high-volume years and tells you little about
  any specific year.

The user framed it precisely: *"wage for 16 years is not helpful, right?"* The
fix is to let the reader **scope to a fiscal year** — defaulting to the latest
(the question most people are actually asking) — while keeping the long view one
click away.

## The hard constraint: this is a statically generated site

The whole performance/SEO model of `apps/analytics-web` is **SSG**: every entity
page has `generateStaticParams` + `dynamicParams = false`, pre-rendered to HTML at
build time, edge-cached at CloudFront with `s-maxage=31536000`, served with **zero
Lambda render** on a hit. Crawlers get complete HTML; users get instant pages.

The naive way to add "filter by year" — read the year from the URL with
`useSearchParams` — **silently breaks that.** In the Next.js 15 App Router,
calling `useSearchParams` inside a client component opts the whole surrounding
route *out* of static generation: the page falls back to dynamic rendering, the
pre-rendered HTML becomes a Suspense fallback for crawlers, and the edge cache
stops helping. That is exactly the property the site is built to keep.

So the design constraint was: **add a time dimension with zero loss of static
generation.** Everything below follows from that.

## The pattern: server shapes the data, the client only toggles

Two rules made it work:

1. **The year filter is pure client state, never a route input.** State lives in
   React (`useState`), and is *mirrored* to `?fy=` via `window.history`
   (`useYearParam` in `components/YearSelector.tsx`) — not read from it during
   render. It **defaults to the latest fiscal year**, which is exactly what the
   pre-rendered HTML shows, so first paint matches the SSG output and there is no
   hydration mismatch. A deep link to `?fy=2018` is honoured in a post-mount
   `useEffect` (one extra client render), which is fine — the latest year is the
   canonical, crawlable content.

2. **The server pre-computes one display-ready "bundle" per scope; the client
   only picks which bundle to show.** All data shaping (top-N, percentages, chart
   series) happens at build time on the server. The client component holds the
   selected year and renders `bundles['all']` or `bundles[year]`. No data logic,
   no refetch, no async on the client.

### The homepage: a client Context over server children

The homepage is the rich case — the *entire dashboard* re-scopes (KPI strip,
highest-paying-occupations chart, industry-mix donut, top-states bar, and the
top-sponsor/occupation tables). But those year-aware blocks are **interleaved
with server components** (`Summary`, ad slots) that must stay server-rendered.

The clean resolution is a **client Context provider that wraps the page, with the
server components passed straight through as `children`**:

```
<HomeYearProvider years={…} defaultYear={latest}>   // 'use client' — owns selected year
   <HomeYearBar/>                                    // the picker (client)
   <HomeKpiStrip   bundles={…}/>                     // client island, reads context
   <Summary .../>                                    // SERVER component — passes through
   <AdSlot .../>                                      //   "
   <HomeCharts     bundles={…}/>                      // client island
   <HomeTopTables  bundles={…}/>                      // client island
</HomeYearProvider>
```

This is the canonical "client component with server children" composition: the
server page (`app/page.tsx`) constructs every child — including the server-only
`Summary` and `AdSlot` — and hands them to the client provider as `children`. The
provider just renders `{children}` inside a React context; the small client
**islands** (`components/home/HomeKpiStrip|HomeCharts|HomeTopTables.tsx`) read the
selected year from `useHomeYear()`. One source of truth for the year, server
components untouched, page still SSG. (`components/home/HomeYearContext.tsx`,
`bundles.ts`.)

### The entity pages: a deliberately lighter touch

Employer / occupation / state / sector pages get **only a latest-FY / All-years
toggle** (`LatestAllToggle`), not the full year picker. This was a product call,
not a technical one: the full picker is the *homepage's* job; on a single entity,
contrasting "this entity's latest year" against "all years" answers the question
without 16 buttons. The hero KPIs re-scope (filings, and — per year — employer
certified/withdrawn/denied %, occupation P25/P50/P75 wages, state national
share); the trend charts stay full-history by definition. Implemented as
`components/hero/{Employer,Occupation,State,Sector}HeroClient.tsx`.

## The per-year data model — precompute vs. derive

The year dimension needed per-year data in `lca.db`. The guiding principle was
**don't balloon the file**: a *fully* per-year dashboard (every top-N table
recomputed for every year) would multiply the snapshot ~16×. So:

- **Re-scoped per year** (cheap, headline only): filings everywhere; employer
  outcome rates; occupation wage percentiles; state share; site KPIs. These come
  from per-year matviews — `mv_employer_growth_by_year` (+ outcome FILTER counts),
  `mv_wage_by_soc_year` (+ P25/P75), `mv_site_dims_by_year` (distinct
  sponsors/SOCs/yr) — exported to `employer_yearly`, `occupation_yearly`,
  `site_yearly`, etc.
- **Homepage leaderboards**: mostly **derived at build time** from the per-year
  tables that already exist (`getHomeTop{Employers,Occupations,Sectors,States}ByYear`
  in `lib/queries.ts` run a windowed top-N over `employer_yearly` /
  `occupation_yearly` / `sector_yearly` / `state_yearly`). Only "top-paying
  occupations per year" needed a dedicated precomputed table
  (`site_top_paying_occ_yearly`), because that ranking is by *wage*, and the
  highest-wage SOCs are niche and fall outside the by-filings top-N.
- **Top-N entity tables stay all-time**, clearly labelled "all years 2010–2025".
  Per-year top-N is the expensive part and the marginal-value part; it was left
  as a future enhancement.

Net cost to the snapshot: a few hundred extra rows + a handful of integer columns
— negligible, versus the ~16× blow-up the naive design would have caused.

## Honest limitation — pre-2020 occupation coverage

Per-year **filings** and **wages** are complete for every year (they don't depend
on SOC). Per-year **occupation/SOC** breakdowns are **not**: a large share of the
FY2010–2019 backfill is not yet SOC-classified (see
`soc_classifier_evolution.md` → "All-Years Coverage Audit"), so scoping to a
pre-2020 year under-counts occupations. The site states this on the methodology
page rather than silently presenting half-populated data — the project's standing
rule that an honest gap beats a hidden one.

## What we learned

- **A time filter is a data-shaping problem, not a routing problem.** The instinct
  to put the year in the URL is the one thing that breaks SSG. Keeping it as client
  state + a cosmetic `?fy=` mirror preserved every static-generation guarantee.
- **"Pass server components as children to a client provider"** is the right tool
  whenever interactive state must span server-rendered sections — far cleaner than
  lifting everything into one giant client component or duplicating state across
  islands.
- **Precompute narrowly.** The temptation was per-year *everything*; the disciplined
  version re-scopes only the headline metrics and derives leaderboards at build
  time, which is what kept the read-only snapshot small and the pages instant.

---

*Last updated: 2026-06-07*
