/**
 * Forward-year forecast generator (e.g. FY2026 before any FY2026 data exists).
 *
 * Numbers are computed DETERMINISTICALLY from the historical series (OLS linear
 * regression on the recent window + CAGR) — never invented by the model. The LLM
 * is given the real series + the computed projection + current momentum, and only
 * writes the *narrative*. That keeps the page credible (and AdSense-safe).
 *
 * Run after build-sqlite.ts (needs site_yearly + employer/occupation tables).
 * Writes one row into site_forecast for year = last_year + 1. When that year's
 * real data lands, last_year advances, the forecast moves to the next year, and
 * the old /h1b-<year> page 301s to home (handled in the route).
 *
 * Stub mode (LLM_PROVIDER != anthropic): still writes the row with a deterministic
 * narrative, so dev builds produce a working page.
 */
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'lca.db');
const MODEL = process.env.LLM_FORECAST_MODEL ?? 'claude-sonnet-4-6';
const PROJECTION_WINDOW = Number(process.env.FORECAST_WINDOW ?? 8); // recent years used for the trend

const FORECAST_SCHEMA = z.object({
  meta_title: z.string().describe('HTML <title>, at most 60 chars, e.g. "H-1B 2026 Forecast — Filings & Salary Outlook".'),
  meta_description: z.string().describe('Meta description, at most 155 chars, stating the projected FY headline and that it is a data-driven forecast.'),
  intro: z.string().describe('1-2 short paragraphs framing the forecast year outlook. Make explicit it is a projection from historical DOL trends, not official data.'),
  filings_outlook: z.string().describe('1 paragraph: the filings trajectory and the projected volume for the forecast year, and what is driving it (cap dynamics, tech demand, etc.).'),
  wage_outlook: z.string().describe('1 paragraph: the prevailing-wage / median-salary trend and its projected direction.'),
  sponsors_outlook: z.string().describe('1 paragraph: which employers are likely to lead sponsorship next year, grounded in the recent leaders given.'),
  occupations_outlook: z.string().describe('1 paragraph: the occupations likely to dominate or grow, grounded in the data given.'),
  bottom_line: z.string().describe('A 1-2 sentence takeaway.'),
});
type ForecastContent = z.infer<typeof FORECAST_SCHEMA>;

const SYSTEM_PROMPT = `You are an analyst writing a forward-year forecast for an H-1B / Labor Condition Application (LCA) analytics website. You are given the real historical series (filings and median wage by US fiscal year), a DETERMINISTIC statistical projection for the forecast year (already computed — do not change it), and the current leading employers and occupations.

Write a credible, sober forecast narrative grounded ONLY in the data provided.
Rules:
- Use the PROVIDED projected numbers exactly. Never invent or alter figures.
- Be explicit that this is a data-driven projection from historical DOL trends, not official or guaranteed data.
- No hype, no clickbait, no false precision. Analytical and neutral.
- Write in English. Keep the meta_title <= 60 chars and meta_description <= 155 chars.`;

function isAnthropic(): boolean {
  return (process.env.LLM_PROVIDER ?? 'stub').toLowerCase() === 'anthropic' && !!process.env.LLM_API_KEY;
}

/** OLS linear regression y = a + b·x; returns projection + a residual-based band. */
function project(points: Array<{ x: number; y: number }>, targetX: number) {
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.x, 0);
  const sy = points.reduce((s, p) => s + p.y, 0);
  const sxx = points.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  const b = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  const yhat = (x: number) => a + b * x;
  const resid = points.map((p) => p.y - yhat(p.x));
  const rmse = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / Math.max(1, n - 2));
  const proj = Math.max(0, yhat(targetX));
  return { proj, lo: Math.max(0, proj - 1.5 * rmse), hi: proj + 1.5 * rmse, slope: b };
}

function cagrPct(first: number, last: number, years: number): number {
  if (first <= 0 || years <= 0) return 0;
  return (Math.pow(last / first, 1 / years) - 1) * 100;
}

async function main() {
  const db = new DatabaseSync(DB_PATH);

  const yearly = db.prepare(
    `SELECT year, filings, median_wage FROM site_yearly ORDER BY year ASC`,
  ).all() as Array<{ year: number; filings: number; median_wage: number | null }>;
  if (yearly.length < 3) { console.log('[forecast] not enough yearly data — skipping.'); db.close(); return; }

  const lastYear = yearly[yearly.length - 1]!.year;
  const targetYear = lastYear + 1;

  // Recent window for a representative trend (the early years understate today's run-rate).
  const window = yearly.slice(-PROJECTION_WINDOW);
  const filingsPts = window.map((r) => ({ x: r.year, y: r.filings }));
  const wagePts = window.filter((r) => r.median_wage != null).map((r) => ({ x: r.year, y: r.median_wage as number }));

  const f = project(filingsPts, targetYear);
  const w = wagePts.length >= 3 ? project(wagePts, targetYear) : null;
  const cagr = cagrPct(window[0]!.filings, window[window.length - 1]!.filings, window[window.length - 1]!.year - window[0]!.year);

  // Current momentum: top sponsors + fastest-growing occupations (best-effort; tables exist post build-sqlite).
  const topSponsors = safeAll(db, `SELECT canonical_name, filings, certified_pct FROM employer ORDER BY filings DESC LIMIT 10`);
  const topOccupations = safeAll(db, `SELECT soc_title, filings, p50_wage FROM occupation ORDER BY filings DESC LIMIT 10`);

  const proj = {
    target_year: targetYear,
    projected_filings: Math.round(f.proj),
    projected_filings_low: Math.round(f.lo),
    projected_filings_high: Math.round(f.hi),
    projected_median_wage: w ? Math.round(w.proj) : null,
    filings_cagr_pct: Number(cagr.toFixed(1)),
  };

  console.log(`[forecast] target=${targetYear} projected_filings=${proj.projected_filings} (${proj.projected_filings_low}-${proj.projected_filings_high}) cagr=${proj.filings_cagr_pct}% model=${isAnthropic() ? MODEL : 'stub'}`);

  let content: ForecastContent;
  let model = 'stub';
  if (isAnthropic()) {
    const payload = {
      forecast_year: targetYear,
      historical: yearly,
      projection: proj,
      current_top_sponsors: topSponsors,
      current_top_occupations: topOccupations,
    };
    const client = new Anthropic({ apiKey: process.env.LLM_API_KEY });
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: `Write the FY${targetYear} forecast from this data:\n\n${JSON.stringify(payload, null, 2)}` }],
      output_config: { format: zodOutputFormat(FORECAST_SCHEMA) },
    });
    if (!res.parsed_output) throw new Error('[forecast] no parsed_output from model');
    content = res.parsed_output;
    model = res.model;
  } else {
    content = stub(proj);
  }

  db.prepare(`
    INSERT INTO site_forecast (year, generated_at, base_first_year, base_last_year,
      proj_filings, proj_filings_lo, proj_filings_hi, proj_median_wage, cagr_pct, content_json, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(year) DO UPDATE SET
      generated_at = excluded.generated_at, base_first_year = excluded.base_first_year,
      base_last_year = excluded.base_last_year, proj_filings = excluded.proj_filings,
      proj_filings_lo = excluded.proj_filings_lo, proj_filings_hi = excluded.proj_filings_hi,
      proj_median_wage = excluded.proj_median_wage, cagr_pct = excluded.cagr_pct,
      content_json = excluded.content_json, model = excluded.model
  `).run(
    targetYear, Math.floor(Date.now() / 1000), window[0]!.year, lastYear,
    proj.projected_filings, proj.projected_filings_low, proj.projected_filings_high,
    proj.projected_median_wage, proj.filings_cagr_pct, JSON.stringify(content), model,
  );
  db.close();
  console.log(`[forecast] wrote site_forecast for FY${targetYear}.`);
}

function safeAll(db: DatabaseSync, sql: string): unknown[] {
  try { return db.prepare(sql).all(); } catch { return []; }
}

function stub(p: { target_year: number; projected_filings: number; filings_cagr_pct: number }): ForecastContent {
  const n = p.projected_filings.toLocaleString();
  return {
    meta_title: `H-1B ${p.target_year} Forecast — Filings & Salary Outlook`,
    meta_description: `Projected ~${n} H-1B LCA filings in FY${p.target_year}, based on historical DOL trends. A data-driven forecast, updated when real data lands.`,
    intro: `This is a data-driven projection of US H-1B / LCA activity for fiscal year ${p.target_year}, extrapolated from historical Department of Labor disclosure trends. It is a forecast, not official data, and will be replaced with actuals as FY${p.target_year} releases are published.`,
    filings_outlook: `Filings have trended at roughly ${p.filings_cagr_pct}% per year over the recent window, implying approximately ${n} LCA filings in FY${p.target_year} if the trajectory holds.`,
    wage_outlook: `Median prevailing wages have risen steadily; the same trend projects continued upward movement into FY${p.target_year}.`,
    sponsors_outlook: `The largest recent sponsors are likely to remain the leading filers, barring major policy or hiring shifts.`,
    occupations_outlook: `Computer and engineering occupations dominate recent filings and are projected to continue leading FY${p.target_year} demand.`,
    bottom_line: `Expect roughly ${n} filings in FY${p.target_year} on current trends — a projection that will sharpen as real data arrives.`,
  };
}

main().catch((err) => { console.error('[forecast] FAILED:', err); process.exit(1); });
