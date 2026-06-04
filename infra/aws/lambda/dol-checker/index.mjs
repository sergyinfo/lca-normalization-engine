/**
 * Precise DOL release checker (daily, via EventBridge).
 *
 * Scrapes the OFLC performance page, extracts the H-1B **LCA Disclosure** file
 * URLs (filing_year >= HARVEST_START_YEAR), and computes a high-water mark
 * "YYYY-Q" of the newest in-scope file (annual files count as Q4). If that's
 * newer than the value stored in SSM, a genuinely new quarterly LCA release has
 * appeared -> trigger the burst pipeline. This fires the (expensive) EC2 burst
 * ONLY on real new LCA data, not on any change to the (multi-program) page.
 *
 * The quarterly files are cumulative, so "newest (year, quarter)" is the right
 * signal — it lines up with the harvester's per-year supersede logic.
 *
 * Event: { dryRun?: boolean } — dryRun returns the analysis WITHOUT triggering
 * a burst or persisting state. Used to probe DOL reachability from AWS and to
 * confirm the live filename pattern.
 */

import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import {
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';

const ssm = new SSMClient({});
const sfn = new SFNClient({});

const DOL_URL           = process.env.DOL_URL;
const HW_PARAM          = process.env.LAST_ETAG_PARAM;     // reused param; now holds "YYYY-Q"
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;
const START_YEAR        = Number(process.env.HARVEST_START_YEAR ?? 2020);
const FILE_PATTERN      = new RegExp(
  process.env.DOL_FILE_PATTERN ?? 'LCA_Disclosure_Data_FY(20\\d{2})',
  'i',
);
// The DOL page is bot-gated — present a browser User-Agent.
const USER_AGENT = process.env.DOL_USER_AGENT ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Quarter from a disclosure filename; annual files (no _Q) = 4 (full year). */
function parseQuarter(name) {
  const m = name.match(/_Q([1-4])/i);
  return m ? Number(m[1]) : 4;
}
/** Sortable "YYYY-Q" — 4-digit year + 1-digit quarter sorts chronologically. */
const hwMark = (year, quarter) => `${year}-${quarter}`;

export const handler = async (event = {}) => {
  if (!DOL_URL || !HW_PARAM || !STATE_MACHINE_ARN) {
    throw new Error('Missing required env vars');
  }
  const dryRun = !!event.dryRun;

  // 1. GET the page with a browser UA.
  const res = await fetch(DOL_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  });
  const html = await res.text();

  // 2. Extract every .xlsx href, then scope to LCA Disclosure files >= floor.
  const hrefs = [...html.matchAll(/href="([^"]+\.xlsx)"/gi)].map((m) => m[1]);
  const inScope = [];
  for (const href of hrefs) {
    const name = href.split('/').pop();
    const pm = name.match(FILE_PATTERN);
    if (!pm) continue;
    const year = pm[1] ? Number(pm[1]) : null;
    if (year == null || year < START_YEAR) continue;
    inScope.push({
      name,
      url: href.startsWith('http') ? href : `https://www.dol.gov${href}`,
      year,
      quarter: parseQuarter(name),
    });
  }

  // Newest in-scope file by (year, quarter).
  const latest = inScope.reduce(
    (best, f) =>
      !best || hwMark(f.year, f.quarter) > hwMark(best.year, best.quarter) ? f : best,
    null,
  );

  const result = {
    httpOk: res.ok,
    status: res.status,
    bytes: html.length,
    xlsxLinks: hrefs.length,
    inScopeCount: inScope.length,
    latest: latest ? hwMark(latest.year, latest.quarter) : null,
    latestFile: latest?.name ?? null,
    sampleInScope: inScope.slice(0, 8).map((f) => f.name),
  };

  // No in-scope LCA files => the page is blocked/changed or the pattern is off.
  // Do NOT trigger and do NOT clobber the stored high-water; surface it loudly.
  if (!latest) {
    return {
      ...result,
      reachable: false,
      changed: false,
      note: 'no in-scope LCA Disclosure files found (bot-block, page change, or pattern mismatch)',
    };
  }

  // 3. Compare to the stored high-water mark.
  const stored = await ssm
    .send(new GetParameterCommand({ Name: HW_PARAM }))
    .then((r) => r.Parameter?.Value)
    .catch(() => null);
  const prev = /^\d{4}-\d$/.test(stored ?? '') ? stored : '0000-0';
  const changed = result.latest > prev;

  result.reachable = true;
  result.previousHighWater = stored;
  result.changed = changed;

  if (!changed) return { ...result, triggered: false };
  if (dryRun) return { ...result, triggered: false, dryRun: true };

  // 4. New release — trigger the burst + persist the new high-water.
  await sfn.send(new StartExecutionCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    name: `dol-trigger-${Date.now()}`,
    input: JSON.stringify({
      trigger: 'new-lca-release',
      latest: result.latest,
      latestFile: result.latestFile,
      detectedAt: new Date().toISOString(),
    }),
  }));
  await ssm.send(new PutParameterCommand({
    Name: HW_PARAM,
    Value: result.latest,
    Overwrite: true,
    Type: 'String',
  }));

  return { ...result, triggered: true };
};
