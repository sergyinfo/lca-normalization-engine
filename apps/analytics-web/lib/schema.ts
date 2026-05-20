/**
 * Schema of the read-only lca.db SQLite file. This is the single source of
 * truth — both `scripts/build-sqlite.ts` (which CREATEs and POPULATEs it)
 * and `lib/queries.ts` (which READs it) import these statements.
 *
 * Schema is intentionally denormalised for read-speed: each row already
 * carries the labels and summary metrics a page needs, so a single
 * indexed PK lookup paints an entity page.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS site_kpis (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  total_records       INTEGER NOT NULL,
  canonical_employers INTEGER NOT NULL,
  distinct_socs       INTEGER NOT NULL,
  first_year          INTEGER NOT NULL,
  last_year           INTEGER NOT NULL,
  median_wage         INTEGER NOT NULL,
  generated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS employer (
  slug                TEXT    PRIMARY KEY,    -- URL slug, e.g. "cognizant"
  canonical_id        TEXT    NOT NULL,       -- canonical_employers.id (UUID) from Postgres
  canonical_name      TEXT    NOT NULL,
  employer_state      TEXT,
  fein                TEXT,
  filings             INTEGER NOT NULL,
  certified_pct       REAL,
  withdrawn_pct       REAL,
  cert_withdrawn_pct  REAL,
  denied_pct          REAL,
  first_year          INTEGER,
  last_year           INTEGER,
  rank                INTEGER NOT NULL        -- 1 = largest sponsor
);
CREATE INDEX IF NOT EXISTS employer_rank_idx ON employer(rank);

-- Per-employer top occupations (rolled up for the page; ≤10 rows per employer).
CREATE TABLE IF NOT EXISTS employer_top_soc (
  employer_slug TEXT NOT NULL,
  soc_code      TEXT NOT NULL,
  soc_title     TEXT,
  filings       INTEGER NOT NULL,
  rank          INTEGER NOT NULL,
  PRIMARY KEY (employer_slug, soc_code),
  FOREIGN KEY (employer_slug) REFERENCES employer(slug)
);
CREATE INDEX IF NOT EXISTS employer_top_soc_idx ON employer_top_soc(employer_slug, rank);

-- Per-employer yearly volume (≤6 rows per employer).
CREATE TABLE IF NOT EXISTS employer_yearly (
  employer_slug TEXT NOT NULL,
  year          INTEGER NOT NULL,
  filings       INTEGER NOT NULL,
  PRIMARY KEY (employer_slug, year)
);

CREATE TABLE IF NOT EXISTS occupation (
  soc_code      TEXT    PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE, -- SEO slug, e.g. "software-developers-15-1252"
  soc_title     TEXT,
  filings       INTEGER NOT NULL,
  n_wages       INTEGER,
  p25_wage      INTEGER,
  p50_wage      INTEGER,
  p75_wage      INTEGER,
  rank          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS occupation_rank_idx ON occupation(rank);
CREATE INDEX IF NOT EXISTS occupation_slug_idx ON occupation(slug);

-- Per-occupation wage by PW_WAGE_LEVEL (I/II/III/IV) — 4 rows per SOC.
CREATE TABLE IF NOT EXISTS occupation_level (
  soc_code      TEXT NOT NULL,
  wage_level    TEXT NOT NULL,
  n_wages       INTEGER,
  p25_wage      INTEGER,
  p50_wage      INTEGER,
  p75_wage      INTEGER,
  PRIMARY KEY (soc_code, wage_level)
);

-- Per-occupation top hiring states (≤10 rows per SOC).
CREATE TABLE IF NOT EXISTS occupation_top_state (
  soc_code TEXT NOT NULL,
  state    TEXT NOT NULL,
  filings  INTEGER NOT NULL,
  p50_wage INTEGER,
  rank     INTEGER NOT NULL,
  PRIMARY KEY (soc_code, state)
);

-- Per-occupation top employers (≤10 rows per SOC).
CREATE TABLE IF NOT EXISTS occupation_top_employer (
  soc_code      TEXT NOT NULL,
  employer_slug TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  filings       INTEGER NOT NULL,
  rank          INTEGER NOT NULL,
  PRIMARY KEY (soc_code, employer_slug)
);

-- Per-occupation yearly median wage.
CREATE TABLE IF NOT EXISTS occupation_yearly (
  soc_code    TEXT NOT NULL,
  year        INTEGER NOT NULL,
  filings     INTEGER,
  median_wage INTEGER,
  PRIMARY KEY (soc_code, year)
);

CREATE TABLE IF NOT EXISTS state (
  code         TEXT    PRIMARY KEY,    -- "CA"
  slug         TEXT    NOT NULL UNIQUE,-- SEO slug, e.g. "california-ca"
  name         TEXT    NOT NULL,       -- "California"
  filings      INTEGER NOT NULL,
  rank         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS state_rank_idx ON state(rank);
CREATE INDEX IF NOT EXISTS state_slug_idx ON state(slug);

-- Per-state top employers (≤10 rows per state).
CREATE TABLE IF NOT EXISTS state_top_employer (
  state_code   TEXT NOT NULL,
  employer_slug TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  filings      INTEGER NOT NULL,
  share_pct    REAL,
  rank         INTEGER NOT NULL,
  PRIMARY KEY (state_code, employer_slug)
);

-- Per-state top occupations (≤10 rows per state).
CREATE TABLE IF NOT EXISTS state_top_occupation (
  state_code TEXT NOT NULL,
  soc_code   TEXT NOT NULL,
  soc_title  TEXT,
  filings    INTEGER NOT NULL,
  rank       INTEGER NOT NULL,
  PRIMARY KEY (state_code, soc_code)
);

CREATE TABLE IF NOT EXISTS sector (
  naics2    TEXT    PRIMARY KEY,
  slug      TEXT    NOT NULL UNIQUE,   -- SEO slug, e.g. "arts-entertainment-recreation-71"
  label     TEXT    NOT NULL,
  filings   INTEGER NOT NULL,
  employers INTEGER NOT NULL,
  rank      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sector_rank_idx ON sector(rank);
CREATE INDEX IF NOT EXISTS sector_slug_idx ON sector(slug);

-- Per-sector top sponsoring employers (≤10 rows per sector).
CREATE TABLE IF NOT EXISTS sector_top_employer (
  naics2         TEXT    NOT NULL,
  employer_slug  TEXT    NOT NULL,
  canonical_name TEXT    NOT NULL,
  filings        INTEGER NOT NULL,
  rank           INTEGER NOT NULL,
  PRIMARY KEY (naics2, employer_slug)
);

-- Per-sector top occupations (≤10 rows per sector).
CREATE TABLE IF NOT EXISTS sector_top_occupation (
  naics2     TEXT    NOT NULL,
  soc_code   TEXT    NOT NULL,
  soc_title  TEXT,
  filings    INTEGER NOT NULL,
  rank       INTEGER NOT NULL,
  PRIMARY KEY (naics2, soc_code)
);

-- Per-sector top hiring states (≤10 rows per sector).
CREATE TABLE IF NOT EXISTS sector_top_state (
  naics2     TEXT    NOT NULL,
  state      TEXT    NOT NULL,
  filings    INTEGER NOT NULL,
  rank       INTEGER NOT NULL,
  PRIMARY KEY (naics2, state)
);

-- Per-sector yearly filings.
CREATE TABLE IF NOT EXISTS sector_yearly (
  naics2  TEXT    NOT NULL,
  year    INTEGER NOT NULL,
  filings INTEGER NOT NULL,
  PRIMARY KEY (naics2, year)
);

-- Per-state yearly filings (drives list-page sparklines + state entity trend).
CREATE TABLE IF NOT EXISTS state_yearly (
  state_code TEXT    NOT NULL,
  year       INTEGER NOT NULL,
  filings    INTEGER NOT NULL,
  PRIMARY KEY (state_code, year)
);

-- LLM-generated per-page summaries. Keyed by (kind, slug); skip-if-unchanged
-- via the data_hash column. Generated quarterly by scripts/generate-summaries.ts.
CREATE TABLE IF NOT EXISTS entity_summary (
  kind         TEXT NOT NULL CHECK (kind IN ('employer','occupation','state','sector','site')),
  slug         TEXT NOT NULL,
  summary_md   TEXT NOT NULL,
  data_hash    TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  model        TEXT,
  PRIMARY KEY (kind, slug)
);

-- SEO: when a previously-included entity falls out of the top-N during a
-- quarterly rebuild, its URL was indexed by search engines but the new
-- build doesn't produce a static page for it. To preserve link equity and
-- avoid 404s, we keep a row here and serve a 301 redirect (via
-- next.config.ts).
--
-- Populated by scripts/build-sqlite.ts at build time: it reads the OLD
-- lca.db (if any) for past entity slugs + past redirect sources, then for
-- every historical slug not in the new build, ensures a redirect exists.
-- If a slug rejoins the top-N, its old redirect row is NOT inserted, so
-- the entity page resolves normally again.
CREATE TABLE IF NOT EXISTS redirects (
  source_path TEXT PRIMARY KEY,    -- e.g. "/employer/acme-corp"
  target_path TEXT NOT NULL,       -- e.g. "/employer"
  reason      TEXT NOT NULL,       -- "dropped-from-top-N", "renamed", etc.
  added_at    INTEGER NOT NULL     -- unix epoch seconds
);
`;

/** Types of entity pages the site renders. Used by sitemap + summary script. */
export type EntityKind = 'employer' | 'occupation' | 'state' | 'sector';
