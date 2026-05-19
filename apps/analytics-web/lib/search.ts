/**
 * Multi-entity search across the read-only SQLite. Used by /search and
 * (optionally) the API later.
 *
 * Implementation: case-insensitive LIKE across the canonical text columns
 * of each entity table. SQLite is case-insensitive on LIKE for ASCII by
 * default, which covers every value in the launch slice. Results are
 * capped per kind so the page is bounded; the launch corpus only holds
 * ~150 entities total, so we never approach the cap.
 *
 * Wildcard escape: `%` and `_` in the user query are escaped so a search
 * for "10% off" doesn't match everything.
 */

import { queryAll } from './db';

export interface SearchHit {
  kind: 'employer' | 'occupation' | 'state' | 'sector';
  slug: string;
  primary: string;            // headline label
  secondary: string | null;   // context (e.g. state, SOC code)
  filings: number | null;
}

const PER_KIND = 10;

export function searchAll(query: string): SearchHit[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;

  const employers = queryAll<{ slug: string; canonical_name: string;
    employer_state: string | null; filings: number; fein: string | null }>(
    `SELECT slug, canonical_name, employer_state, filings, fein
       FROM employer
      WHERE canonical_name LIKE ? ESCAPE '\\' OR fein LIKE ? ESCAPE '\\'
      ORDER BY filings DESC LIMIT ?`,
    like, like, PER_KIND,
  );

  const occupations = queryAll<{ slug: string; soc_code: string;
    soc_title: string | null; filings: number }>(
    `SELECT slug, soc_code, soc_title, filings
       FROM occupation
      WHERE soc_title LIKE ? ESCAPE '\\' OR soc_code LIKE ? ESCAPE '\\'
      ORDER BY filings DESC LIMIT ?`,
    like, like, PER_KIND,
  );

  const states = queryAll<{ slug: string; code: string; name: string; filings: number }>(
    `SELECT slug, code, name, filings
       FROM state
      WHERE name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\'
      ORDER BY filings DESC LIMIT ?`,
    like, like, PER_KIND,
  );

  const sectors = queryAll<{ slug: string; naics2: string; label: string; filings: number }>(
    `SELECT slug, naics2, label, filings
       FROM sector
      WHERE label LIKE ? ESCAPE '\\' OR naics2 = ?
      ORDER BY filings DESC LIMIT ?`,
    like, q, PER_KIND,
  );

  return [
    ...employers.map<SearchHit>((e) => ({
      kind: 'employer', slug: e.slug, primary: e.canonical_name,
      secondary: e.employer_state, filings: e.filings,
    })),
    ...occupations.map<SearchHit>((o) => ({
      kind: 'occupation', slug: o.slug, primary: o.soc_title ?? o.soc_code,
      secondary: o.soc_code, filings: o.filings,
    })),
    ...states.map<SearchHit>((s) => ({
      kind: 'state', slug: s.slug, primary: s.name, secondary: s.code, filings: s.filings,
    })),
    ...sectors.map<SearchHit>((s) => ({
      kind: 'sector', slug: s.slug, primary: s.label,
      secondary: `NAICS ${s.naics2}`, filings: s.filings,
    })),
  ];
}
