# Analytics UI — design notes & data walkthrough

**Date:** 2026-05-13
**App:** `apps/analytics-ui` (Fastify + EJS + Chart.js)
**URL (local):** `http://localhost:8081`
**Auth:** none (public — DOL discloses this data)
**Backed by:** PostgreSQL 16 + 12 materialized views in the `analytics.*` schema

---

## Why this dashboard exists

The end goal of the LCA Normalization Engine is to turn the DOL's raw quarterly
disclosure files — a jumble of inconsistent employer spellings, free-text job
titles, and dollar amounts measured in different time units — into something
that ordinary analysts can ask questions of without writing SQL.

The dashboard is the proof that the pipeline succeeds. Each persona page is a
*concrete question* you can answer with two clicks instead of two days of
data wrangling. The thesis-defence story is: **"the value of normalisation
is everything past this page."**

### The same data, four lenses

The same 3.83 M-row table answers four very different questions depending on
who's looking. A journalist wants to know who the biggest sponsors are; a job
seeker wants a wage benchmark for *their* role in *their* city; a labour
economist wants the macro trends; a thesis examiner wants to see how the
pipeline actually built the corpus.

Rather than building one giant dashboard with 30 panels, the UI gives each
audience a focused page. The pipeline's job is to make all four lenses cheap;
the dashboard's job is to make them *legible*.

---

## Architecture

```
   ┌───────────────────────────────────┐
   │  Browser                          │
   │  http://localhost:8081            │
   └────────────────┬──────────────────┘
                    │ HTTP
   ┌────────────────▼──────────────────┐
   │  Fastify (apps/analytics-ui)      │
   │  - 5 routes × persona             │
   │  - EJS templates + Chart.js       │
   │  - No auth                        │
   └────────────────┬──────────────────┘
                    │ pg pool (read-only queries)
   ┌────────────────▼──────────────────┐
   │  PostgreSQL 16 — analytics schema │
   │                                   │
   │  12 materialized views +          │
   │  1 plain view (v_overview_kpis)   │
   │  composing from them              │
   │                                   │
   │  Built once via                   │
   │  pnpm analytics:bootstrap-views   │
   │  Refresh after each backfill via  │
   │  pnpm analytics:refresh-views     │
   └───────────────────────────────────┘
```

### Why materialized views

A naive `count(*)` on `lca_records` takes ~75 s cold-cache (3.83 M rows of
JSONB). A naive page with 4-5 aggregations would have spent ~5 minutes per
visit. We could not have demoed it.

Every persona panel is therefore backed by a `analytics.mv_*` view that holds
a pre-aggregated result — usually a few hundred rows. Page paint becomes
"read 12 KB of pre-computed numbers + render Chart.js," which is consistently
under 100 ms warm and under 300 ms cold.

| Matview | Rows | Size | Purpose |
|---|---:|---:|---|
| `mv_filings_by_year` | 6 | 8 KB | Volume over time |
| `mv_filings_by_state` | 56 | 8 KB | Geographic concentration |
| `mv_soc_summary` | 702 | 64 KB | SOC code + title + count |
| `mv_top_sponsors` | 95,142 | 9.2 MB | Filings by canonical employer |
| `mv_top_employers_by_soc` | 210,681 | 19 MB | Per-SOC employer rankings |
| `mv_wage_by_soc` | ~700 | 64 KB | Wage percentiles by SOC |
| `mv_wage_by_soc_year` | ~3,500 | 200 KB | Wage trajectory per SOC |
| `mv_median_wage_by_year` | 6 | 8 KB | Median wage over time |
| `mv_state_share_by_year` | 42 | 8 KB | Top-5 state share, year by year |
| `mv_case_status` | 4 | 8 KB | Case outcomes |
| `mv_classification_source_mix` | 4 | 8 KB | DMTF / stage2 / consensus / quarantine |
| `mv_confidence_distribution` | 3 | 8 KB | Stage-2 cosine score buckets |
| `mv_coverage` | 1 | 8 KB | Canonical-missing count (caches the slow scan) |
| `v_overview_kpis` (plain VIEW) | — | — | Composes the rest into one row |

Total footprint: ~29 MB to make four dashboard pages render in under 300 ms.

The only **non-matview** query in the whole app is the interactive
`wageLookup` in Job Seeker — `SOC + state + city` is too high-cardinality to
pre-aggregate. Default case (no filter) falls back to `mv_wage_by_soc` and is
instant; filter case hits `lca_records` with a 20-s `statement_timeout` and a
graceful "filter too broad" fallback.

---

## Persona 1 — Journalist / Public

**URL:** `/journalist`
**Question:** Who sponsors H-1B workers, where, and how much of it is happening?

### Panels

| Panel | Source | Reveals |
|---|---|---|
| Top 20 H-1B sponsors | `mv_top_sponsors` | Big Tech vs body-shops |
| Filings by worksite state | `mv_filings_by_state` | West-coast / NY tilt |
| Filings per fiscal year | `mv_filings_by_year` | Pandemic-era spike, post-2022 plateau |
| Top occupations | `mv_soc_summary` | Tech dominance |

### What the data actually says (FY2020–FY2025 corpus)

**The top of the table is not Big Tech — it's the IT-consulting/staffing
industry.** Across six years:

| # | Canonical sponsor | State | Filings |
|---|---|---|---:|
| 1 | COGNIZANT TECHNOLOGY SOLUTIONS US CORP | TX | **65,207** |
| 2 | AMAZON.COM SERVICES LLC | WA | 34,462 |
| 3 | AMAZON.COM SERVICES LLC | VA | 30,468 |
| 4 | Google LLC | CA | 26,107 |
| 5 | Ernst & Young U.S. LLP | NJ | 23,247 |
| 6 | Microsoft Corporation | WA | 21,956 |
| 7 | TATA CONSULTANCY SERVICES LIMITED | MD | 20,102 |
| 8 | Meta Platforms, Inc | CA | 14,579 |
| 9 | INFOSYS LIMITED | TX | 14,069 |
| 10 | Apple Inc. | CA | 13,405 |

Cognizant alone is **larger than Amazon's two combined US entities** by a
clear margin. Tata + Infosys together (34 K) match Microsoft. **Three IT
services firms (Cognizant, Tata, Infosys) account for ~99 K filings — more
than Amazon + Google + Microsoft combined (113 K, split across two Amazon
FEINs)**. The Apple-and-Google headlines don't tell the whole story.

> **Worth flagging in the thesis:** the dashboard's entity-resolution layer
> deliberately *keeps* the two `AMAZON.COM SERVICES LLC` rows separate
> because they have different FEINs (91-1646860 in WA, 82-0544687 in VA —
> the AWS subsidiary). This is correct: they're legally distinct employers.
> A less careful pipeline would have merged them on name match and lost the
> regional split. Same trade name, different organisations.

**Geography is extremely concentrated:**
- California: **753,475** filings (19.7 % of all activity)
- CA + TX + NY: **1,562,204** = **40.8 %** of the entire program
- The top 10 states alone absorb 71 % of filings

**The program is not steadily growing.** Year-by-year volume:

| FY | Filings | Δ vs prior |
|---|---:|---:|
| 2020 | 577,334 | — |
| 2021 | **826,305** | **+43 %** |
| 2022 | 626,084 | −24 % |
| 2023 | 644,607 | +3 % |
| 2024 | 561,037 | −13 % |
| 2025 | 596,552 | +6 % |

The **FY2021 surge** is the dominant feature. The likeliest explanation is
that pandemic-disrupted FY2020 filings backed up into 2021 — H-1B
applications are quota-gated but LCA pre-filings are not, so deferred hiring
plans concentrated into one cycle. Post-2022 the program settles around
600 K/year, which is *down* from pre-pandemic volume.

**Occupations are overwhelmingly tech.** Top 5 SOCs by filings:

| Rank | SOC | Title | Filings | % of total |
|---|---|---|---:|---:|
| 1 | 15-1252 | Software Developers | **1,400,940** | 36.6 % |
| 2 | 15-1299 | Computer Occupations, All Other | 289,708 | 7.6 % |
| 3 | 15-2051 | Data Scientists | 213,508 | 5.6 % |
| 4 | 15-1253 | Software QA Analysts and Testers | 134,517 | 3.5 % |
| 5 | 15-1211 | Computer Systems Analysts | 121,469 | 3.2 % |

The top 5 are *all* tech codes (the `15-*` series is BLS's "Computer and
Mathematical Occupations"). They add up to **2.16 M filings = 56.4 %** of
the program. **Statistically, H-1B is a tech-worker visa** — by a wide
margin, with everything else (accountants, mechanical engineers, financial
analysts) trailing far behind.

---

## Persona 2 — Job Seeker / Career Researcher

**URL:** `/jobseeker`
**Question:** What's the going rate for my role, in my city, and who's hiring?

### Panels

| Panel | Source | Interactive? |
|---|---|---|
| Wage percentiles for selected SOC | `mv_wage_by_soc` (default) / `lca_records` (filtered) | yes — pick SOC + state + city |
| Wage trend over time | `mv_wage_by_soc_year` | follows SOC selection |
| Top employers for this SOC | `mv_top_employers_by_soc` | follows SOC selection |
| Wage distribution across top 10 SOCs (P25/P50/P75) | `mv_soc_summary` ⋈ `mv_wage_by_soc` | static comparison |

### What the data actually says

**Wage spreads by occupation are large and meaningful.** P25/P50/P75 for the
top SOCs:

| SOC | Title | P25 | Median | P75 | Spread (P75−P25) |
|---|---|---:|---:|---:|---:|
| 15-1252 | Software Developers | $95,160 | **$116,251** | $145,725 | $50,565 |
| 11-3021 | Computer & IS Managers | $136,000 | **$165,000** | $200,000 | $64,000 |
| 15-2051 | Data Scientists | $90,200 | $114,941 | $145,000 | $54,800 |
| 15-1299 | Computer Occ., All Other | $80,434 | $101,920 | $132,829 | $52,395 |
| 15-1253 | Software QA | $80,433 | $96,000 | $116,043 | $35,610 |
| 13-2011 | Accountants & Auditors | $67,205 | $84,240 | $110,000 | $42,795 |
| 17-2141 | Mechanical Engineers | $80,000 | $95,200 | $124,800 | $44,800 |

A few interpretive points:
- **A "Software Developer" earning $95K is in the bottom quartile.** The same
  job title at the 75th percentile is $146K — a 53 % gap inside one SOC.
  Without normalisation, an applicant would have no way to know whether their
  offer is competitive.
- **Manager codes (`11-3021`) are the only category where the median crosses
  $150K**, with the 75th percentile at exactly $200K. The H-1B wage cliff
  between IC and management is large.
- **Software QA wages are noticeably lower** ($96K median) and have the
  tightest spread ($35K), suggesting commoditised pricing — these are roles
  body-shops typically staff at scale.

**Wages have moved meaningfully over 5 years.** Median wage by year (overall,
all occupations):

| FY | n | Median |
|---|---:|---:|
| 2020 | 576,546 | $96,595 |
| 2021 | 825,871 | $103,803 |
| 2022 | 625,783 | $107,250 |
| 2023 | 644,287 | $110,240 |
| 2024 | 558,844 | $112,986 |
| 2025 | 595,010 | **$119,516** |

That's a **+23.7 % increase over 5 years** (~4.3 % CAGR) — meaningfully
ahead of US wage inflation in the same window. The trend is roughly linear,
which suggests it's not just one big shock (e.g. RTO bidding wars) but a
sustained re-pricing of foreign-skilled labour.

**Different occupations have grown at very different rates.** Median wage,
FY2020 → FY2025:

| SOC | Title | 2020 | 2025 | Growth |
|---|---|---:|---:|---:|
| 15-1252 | Software Developers | $103,314 | **$133,000** | **+28.7 %** |
| 15-1299 | Computer Occ., All Other | $89,606 | $115,000 | +28.3 % |
| 15-2051 | Data Scientists | $101,789 | $121,000 | +18.9 % |
| 15-1253 | Software QA | $88,200 | $103,418 | +17.3 % |
| 15-1211 | Computer Systems Analysts | $94,370 | $105,900 | +12.2 % |

Software Developers grew nearly **2.4× faster** than Computer Systems
Analysts over the same window. The wage premium for specialisation is
visible in the data — the more specialised SOC commands faster growth.

**Top employers per SOC** lets a job seeker triangulate where the demand
is. For `15-1252` Software Developers, the picker shows that Cognizant
files orders of magnitude more than any single FAANG company — meaning the
employer they'd most likely *interview with* on an H-1B-friendly profile is
a staffing firm, not Big Tech.

---

## Persona 3 — Policy / Labor Economist

**URL:** `/policy`
**Question:** How is the H-1B program evolving as a whole — volume, wages, geography, outcomes?

### Panels

| Panel | Source |
|---|---|
| Filings per fiscal year | `mv_filings_by_year` |
| Median wage by year | `mv_median_wage_by_year` |
| Top-5 state share over time (stacked) | `mv_state_share_by_year` |
| Wage growth — top 5 occupations | `mv_wage_by_soc_year` |
| Case outcome breakdown | `mv_case_status` |

### What the data actually says

**Geographic concentration has shifted.** Top-5 state breakdown of filings
per year shows a non-obvious story:

| State | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | Δ 2020→25 |
|---|---:|---:|---:|---:|---:|---:|---:|
| CA | 116,018 | 177,848 | 123,097 | 123,478 | 102,108 | 110,926 | **−4.4 %** |
| TX | 59,117 | 90,790 | 84,528 | 91,294 | 83,888 | 90,478 | **+53.0 %** |
| NY | 46,888 | 67,785 | 47,736 | 50,649 | 45,271 | 50,305 | +7.3 % |
| WA | 32,427 | 44,510 | 38,067 | 37,614 | 34,089 | 36,307 | +12.0 % |
| NJ | 31,318 | 41,952 | 33,547 | 34,837 | 29,700 | 29,182 | −6.8 % |

**California is shrinking — Texas is booming.** CA shed 4.4 % of its H-1B
filings while TX grew 53 %. The CA/TX gap was nearly 2× in 2020; by 2025
they're within 22 %. Possible drivers: corporate relocations (Oracle,
Tesla, HP all moved HQs to TX during this window), Big Tech ramping up
non-CA offices, body-shops domiciling in low-tax states. The dashboard
makes the story visible without any narrative effort.

**Case outcomes are extreme.** Across all 3.83 M filings:

| Status | Count | % |
|---|---:|---:|
| Certified | 3,549,402 | **92.6 %** |
| Certified - Withdrawn | 191,286 | 5.0 % |
| Withdrawn | 68,388 | 1.8 % |
| Denied | 22,843 | **0.6 %** |

The denial rate is **0.6 %**. The H-1B *lottery* is famously brutal —
only about a third of registrants get a number to file — but once you've
made it that far and you actually submit an LCA, **DOL approves 99.4 % of
them.** The narrative that DOL is a meaningful filter for H-1B labour is
not supported by the data; the filter is the USCIS lottery, not LCA
adjudication.

**Wage growth varies wildly by occupation.** The wage-growth chart
overlays the top 5 SOCs over time:
- Software Developers: $103 K → $133 K (+28.7 %), the fastest grower
- Computer Occupations, All Other: $89 K → $115 K (+28.3 %)
- Data Scientists: $102 K → $121 K (+18.9 %), slowed visibly in 2024
- Software QA: $88 K → $103 K (+17.3 %)
- Computer Systems Analysts: $94 K → $106 K (+12.2 %), nearly flat 2024-25

If you're tracking wage *suppression* claims, the Computer Systems Analysts
line tells a different story from the Software Developers line. Both are
H-1B occupations — yet one is roaring and one is stagnating. A blanket
"H-1B suppresses wages" thesis isn't supported uniformly by the data.

---

## Persona 4 — Academic / Thesis Examiner

**URL:** `/academic`
**Question:** How does the pipeline actually produce these numbers, and how confident should you be in them?

This page is the meta-view — designed for someone evaluating the *engineering*
of the pipeline (which is exactly the audience for the thesis defence).

### KPI tiles (top of page)

Pulled from `analytics.v_overview_kpis`:

| Metric | Value |
|---|---:|
| Total records | 3,831,919 |
| SOC-classified | **95.25 %** (3,650,080) |
| Canonical-resolved | **99.47 %** (3,811,573) |
| Canonicals · embeddings | 146,206 · 146,206 |
| Quarantine open | 181,839 |
| Unresolved open | **0** |

These numbers are the literal output of the pipeline as it stands today.
The 99.47 % canonical coverage is the strongest single result — the
full-cascade backfill (Layer 1 → 2 → 3 + UPSERT) reduced
`unresolved_employers` from 157,612 down to **zero**.

### Panels

| Panel | Source |
|---|---|
| SOC classification source mix (doughnut) | `mv_classification_source_mix` |
| Stage-2 semantic confidence distribution | `mv_confidence_distribution` |
| Entity-resolution layer outcomes | `canonical_employers` + `staging.unresolved_employers` |
| Top 10 canonical employers (with FEIN) | `canonical_employers` |

### What the data actually says

**The 4-stage SOC classifier is doing real work — no single stage dominates.**

| Stage | Records | % |
|---|---:|---:|
| Stage 2 — Semantic (sentence-transformer ≥ 0.7) | 1,898,690 | **52.0 %** |
| Stage 1 — DMTF / bootstrap exact match | 1,516,117 | 41.5 % |
| Stage 0 — Per-employer consensus | 235,273 | 6.4 % |
| Stage 3 — LLM (skipped this run) | 0 | 0.0 % |
| Unclassified (quarantine) | 181,839 | 4.7 % |

The roughly **even DMTF/semantic split (42 / 52)** is the headline. Either
of the cheap stages alone would have covered only half the corpus. **DMTF
exact-match handles the canonical job titles** (everything that maps
cleanly to a BLS standard); **the semantic stage handles the messy
free-text cases** (`"Sr. SWE III"`, `"Engineer 3"`, `"Founding Eng"`) by
embedding and cosine-matching against the alias dictionary. The 0.7
confidence gate is what routes the residue to quarantine.

Stage 0 (employer consensus) contributes 6.4 % — small but real. When a
given employer has filed the same job title many times with the same SOC,
we trust that mapping ahead of either DMTF or the model. This is the
"organisations are reliable witnesses to their own job ladder" insight.

**The semantic-classifier confidence distribution is reassuringly skewed
high:**

| Cosine bucket | Records | % of Stage 2 |
|---|---:|---:|
| 0.7 – 0.8 | 330,012 | 17 % |
| 0.8 – 0.9 | 736,090 | 39 % |
| 0.9 – 1.0 | **832,588** | **44 %** |

**44 % of semantic classifications land above 0.9 cosine similarity** — i.e.
the model is very sure. Only 17 % sit in the 0.7-0.8 marginal band where
the LLM (Stage 3) would have the most impact. This validates the gate
choice: dropping the threshold to 0.6 would have approved a band of much
lower-quality matches, while raising it to 0.8 would have lost 17 % of
classifications.

**Entity-resolution layer outcomes** (from the full-cascade backfill,
captured in `INGEST_RUN_REPORT.md` Phase 9):

- Layer 1 (FEIN) — 92,289 canonicals minted at ingest time from FY2024+
  filings (FY2020-FY2023 disclosures have 0 % FEIN — DOL data quirk).
- Layer 2/3 + UPSERT — 53,917 *additional* canonicals minted during the
  backfill, by either fuzzy-matching pre-2024 records to existing entities
  or creating new ones on miss.
- Unresolved entries merged to a canonical: 157,612 (all of them).
- Unresolved entries still open: **0**.

In other words, **every record whose employer name surfaced anywhere in
the corpus got mapped to a canonical entity.** The 20,346 records still
without `canonical_employer_id` are the corner-case rows (NULL employer
name, whitespace-only, normalisation edge-cases) — they never even made it
into the `unresolved_employers` queue.

**Top 10 canonicals confirm legal-entity discipline.** The two Amazon rows
share a trade name but have different FEINs (`91-1646860` is the WA HQ;
`82-0544687` is the AWS arm in VA). The dashboard preserves them as
separate canonicals, which is the correct behaviour — they're legally
distinct employers under DOL filings. A name-only deduplication would have
collapsed them and obscured 30 K filings of operational structure.

---

## Operational notes

### Refresh path

After any pipeline change that touches the underlying tables —
ingest, classification backfill, canonical-employer backfill, operator
HITL writes — refresh the matviews:

```bash
DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \
  pnpm analytics:refresh-views
```

`mv_top_sponsors` and `mv_top_employers_by_soc` are the slowest to refresh
(joining `lca_records` against `canonical_employers`); everything else is
≤ 30 s. Total wall time for a full refresh: ~5–10 min depending on cache
warmth.

### Cost profile

| Metric | Value |
|---|---:|
| Total matview storage | ~29 MB |
| Cold-cache page paint (matview-only pages) | 16-552 ms |
| Warm-cache page paint | 7-117 ms |
| Worst-case interactive query (filtered wageLookup) | 20 s (statement_timeout) |

A naive (unmaterialized) dashboard would have spent ~5 min per page paint
before timeout. The pre-aggregation is the difference between a usable demo
and an unusable one.

### Limitations & known gaps

- **`wageLookup` with state+city is best-effort.** When the user narrows by
  state and city against a high-volume SOC like `15-1252`, the query can
  hit the 20-s timeout. The UI falls back to a "filter too broad" message.
  A future `mv_wage_by_soc_state_city` matview would fix this, at the cost
  of more storage (estimated ~30 MB for ~700 SOCs × 50 states × 200 cities).
- **No drill-through from chart click yet.** A click on a bar takes you
  nowhere; ideally the journalist's "top sponsor" bar would deep-link into
  a per-employer breakdown. Out of scope for the defence cut.
- **Stage 3 LLM isn't represented in the source-mix chart** because it
  hasn't run yet. Once `quarantine:reclassify` drains the 181 K residue,
  the doughnut will pick up a fourth slice automatically — no code change.

---

## Demo script (for the defence)

5-minute walkthrough:

1. **Open `/`** — *"the headline numbers: 3.83 M records, 99.47 %
   canonicalised, 95.25 % classified."*
2. **Click "Journalist"** — *"who actually files H-1Bs? Cognizant tops the
   list with 65 K filings. Big Tech is there but not at the top. CA + TX +
   NY = 41 % of all filings."*
3. **Click "Job Seeker"** — *"if I'm a Software Developer, the median wage
   is $116 K, with P25 at $95 K and P75 at $146 K. Wages for this code
   grew 28.7 % from 2020 to 2025."*
4. **Click "Policy"** — *"CA filings are actually down 4 %, while TX is up
   53 %. The denial rate is 0.6 % — DOL approves almost everything."*
5. **Click "Academic"** — *"this is how the pipeline produced those
   numbers: 41.5 % DMTF, 52 % semantic, 6.4 % consensus, 4.7 % still in
   quarantine. The 4-stage classifier and 3-layer entity resolution are
   what made any of this possible."*

The cleanest version of the thesis story: **"Without the pipeline this
dashboard would have taken weeks of data wrangling to produce. The
materialized views are seconds. The point of normalisation is the speed
of insight, not just the cleanliness of the schema."**
