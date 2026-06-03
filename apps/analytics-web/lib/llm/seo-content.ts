/**
 * SEO content generation for entity pages — one combined Claude call per page
 * returns the page summary AND the SEO meta (title + description + keywords).
 *
 * Design (see also scripts/generate-summaries.ts):
 *  - Model: Claude Haiku 4.5 (cheap, plenty for short structured copy). Swap to
 *    Sonnet via LLM_SUMMARY_MODEL if quality isn't there.
 *  - Structured output via the SDK's `messages.parse` + a Zod schema — no
 *    fragile "return only JSON" prompting, typed result off `parsed_output`.
 *  - Prompt caching: the (large, fixed) system prompt carries a cache_control
 *    breakpoint, so every page after the first reads it at ~10% input cost.
 *  - Two execution modes: `batch` (Message Batches API, 50% off — for the
 *    quarterly whole-site rebuild) and `sync` (one page at a time — for
 *    on-publish). Models don't count characters reliably, so we ALSO clamp
 *    title/description lengths in code, truncating at a word boundary.
 *
 * This runs at BUILD time only (generate-summaries.ts), never in the Lambda
 * runtime — so @anthropic-ai/sdk + zod are devDependencies.
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** Bump to force a full regeneration when the prompt/schema changes (folded
 *  into the per-entity data_hash, so unchanged prompts skip unchanged data). */
export const PROMPT_VERSION = 'v2-haiku-seo-meta';

export const TITLE_MAX = 60;
export const DESC_MAX = 155;

export const SEO_SCHEMA = z.object({
  meta_title: z
    .string()
    .describe('HTML <title>. At most 60 characters. Lead with the entity name plus a short qualifier (e.g. "H-1B sponsor", "H-1B salary").'),
  meta_description: z
    .string()
    .describe('Meta description. At most 155 characters. One compelling, factual sentence stating the single most useful fact and inviting a click.'),
  summary_md: z
    .string()
    .describe('2-3 short paragraphs of plain markdown for the page body. Neutral and informative; lead with the entity name and what it is.'),
  keywords: z
    .array(z.string())
    .describe('3 to 6 short search phrases a user might type to reach this page.'),
});
export type SeoContent = z.infer<typeof SEO_SCHEMA>;

export const SYSTEM_PROMPT = `You write SEO metadata and short factual summaries for an H-1B / Labor Condition Application (LCA) analytics website. Each request gives you one entity (an employer, occupation, US state, NAICS sector, or the site itself) as a structured JSON data payload.

For that entity, produce:
- meta_title: a compelling HTML <title>, AT MOST 60 characters, leading with the entity name and a short qualifier such as "H-1B sponsor", "H-1B salary guide", or "H-1B filings".
- meta_description: an AT MOST 155-character meta description that states the single most useful fact and invites a click. Specific and factual — no clickbait, no ellipsis padding.
- summary_md: 2-3 short paragraphs of plain markdown for the page body. Neutral, informative, never speculative. Lead with the entity name and what it is, then the H-1B activity. Use natural search phrasing ("H-1B sponsorship", "prevailing wage", role and location terms) without keyword stuffing.
- keywords: 3 to 6 short search phrases a user might plausibly type to reach this page.

Rules:
- Only use figures that appear in the data payload. NEVER invent or estimate numbers.
- Write in English. Avoid filler like "in conclusion" or "this analysis shows".
- The character limits matter — keep the title and description within them.`;

const MODEL = process.env.LLM_SUMMARY_MODEL ?? process.env.LLM_MODEL ?? 'claude-haiku-4-5';

const SYSTEM_BLOCKS: Anthropic.TextBlockParam[] = [
  { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
];
const FORMAT = zodOutputFormat(SEO_SCHEMA);

export interface SeoJob {
  kind: 'employer' | 'occupation' | 'state' | 'sector' | 'site';
  slug: string;
  payload: Record<string, unknown>;
}

export interface SeoResult {
  content: SeoContent;
  model: string;
}

/** True when a real Anthropic run is configured (else callers fall back to stub). */
export function isAnthropicConfigured(): boolean {
  return (process.env.LLM_PROVIDER ?? 'stub').toLowerCase() === 'anthropic' && !!process.env.LLM_API_KEY;
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.LLM_API_KEY) throw new Error('LLM_API_KEY missing; required for LLM_PROVIDER=anthropic');
    _client = new Anthropic({ apiKey: process.env.LLM_API_KEY });
  }
  return _client;
}

/** Truncate to `max` chars at the last word boundary (avoids mid-word cuts). */
function truncateAtWord(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.!-]+$/, '').trim();
}

/** Enforce length limits the model can't reliably self-police. */
export function clampContent(out: SeoContent): SeoContent {
  return {
    meta_title: truncateAtWord(out.meta_title, TITLE_MAX),
    meta_description: truncateAtWord(out.meta_description, DESC_MAX),
    summary_md: out.summary_md.trim(),
    keywords: (out.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 6),
  };
}

export function buildUserPrompt(job: SeoJob): string {
  const data = JSON.stringify(job.payload, null, 2);
  switch (job.kind) {
    case 'employer':
      return `Entity: H-1B sponsoring employer.\nWrite the summary as a company profile: what it appears to be, how active it is in the H-1B program, its role mix and certification record.\n\nData:\n${data}`;
    case 'occupation':
      return `Entity: SOC occupation in the US H-1B program.\nWrite the summary as a salary guide: typical wage range (P25-P75), wage progression across DOL levels I->IV, top hiring states and employers.\n\nData:\n${data}`;
    case 'state':
      return `Entity: US state H-1B sponsorship activity.\nWrite the summary as a state overview: total filing volume, top sponsoring employers (and any concentration), top occupations sponsored.\n\nData:\n${data}`;
    case 'sector':
      return `Entity: NAICS sector H-1B sponsorship.\nWrite the summary as a sector overview: what the sector is, total filings, how many distinct employers participate, what that implies about labour demand.\n\nData:\n${data}`;
    case 'site':
      return `Entity: the analytics site itself (homepage).\nWrite the summary as a "what this site covers" overview: years of data, total disclosures, distinct sponsors and occupations, and the kinds of questions the site answers.\n\nData:\n${data}`;
  }
}

/** One synchronous, structured call (on-publish / small runs). */
export async function generateOne(job: SeoJob): Promise<SeoResult> {
  const res = await client().messages.parse({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_BLOCKS,
    messages: [{ role: 'user', content: buildUserPrompt(job) }],
    output_config: { format: FORMAT },
  });
  if (!res.parsed_output) throw new Error('no parsed_output from model');
  return { content: clampContent(res.parsed_output), model: res.model };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Submit all jobs to the Message Batches API (50% off), poll to completion,
 * and return a map of job-index -> result. Failed/expired items are omitted
 * (the caller logs the gap). `onTick` reports polling progress.
 */
export async function generateBatch(
  jobs: SeoJob[],
  onTick?: (status: string, succeeded: number, total: number) => void,
): Promise<Map<number, SeoResult>> {
  const c = client();
  const batch = await c.messages.batches.create({
    requests: jobs.map((job, i) => ({
      custom_id: `j${i}`,
      params: {
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_BLOCKS,
        messages: [{ role: 'user' as const, content: buildUserPrompt(job) }],
        output_config: { format: FORMAT },
      },
    })),
  });

  // Poll. Haiku batches of this size usually finish in minutes; cap-free wait.
  for (;;) {
    const b = await c.messages.batches.retrieve(batch.id);
    onTick?.(b.processing_status, b.request_counts.succeeded, jobs.length);
    if (b.processing_status === 'ended') break;
    await sleep(20_000);
  }

  const out = new Map<number, SeoResult>();
  for await (const r of await c.messages.batches.results(batch.id)) {
    const idx = Number(r.custom_id.slice(1));
    if (r.result.type !== 'succeeded') continue;
    const text = r.result.message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    try {
      const parsed = SEO_SCHEMA.parse(JSON.parse(text));
      out.set(idx, { content: clampContent(parsed), model: r.result.message.model });
    } catch {
      /* leave the gap; caller counts it as failed */
    }
  }
  return out;
}

/** Deterministic placeholder when no provider is configured (local/CI). */
export function stubContent(job: SeoJob): SeoResult {
  const name = String(job.payload.canonical_name ?? job.payload.name ?? job.payload.label ?? job.payload.soc_title ?? job.slug);
  return {
    content: clampContent({
      meta_title: `${name} — H-1B data`,
      meta_description: `H-1B / LCA disclosure data for ${name}.`,
      summary_md: `*Placeholder summary (stub provider). Configure \`LLM_PROVIDER=anthropic\` + \`LLM_API_KEY\` to generate real content.*`,
      keywords: ['h-1b', 'lca', name.toLowerCase()],
    }),
    model: 'stub',
  };
}