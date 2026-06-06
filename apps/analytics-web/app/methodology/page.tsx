/* SEO parity contract — keep this page and apps/landing/app/methodology/page.tsx in
   sync (title, description, headings, body copy). Same reasoning as /about:
   Google will index the landing first; the analytics-web version must serve
   continuous content at the same URL after cutover. */

import type { Metadata } from 'next';
import Link from 'next/link';
import { entityMetadata, datasetJsonLd } from '@/lib/seo';
import { SITE_URL } from '@/lib/site';
import { getSiteKpis } from '@/lib/queries';

const PAGE_PATH = '/methodology';
const PAGE_DESCRIPTION =
  'How h1b.report turns the US Department of Labor’s public LCA disclosures into a searchable database: data sources, wage methodology, and known limitations.';

export const metadata: Metadata = entityMetadata({
  title: 'Methodology — data sources, wage calculations & limitations',
  description: PAGE_DESCRIPTION,
  path: PAGE_PATH,
});

export default function MethodologyPage() {
  const jsonLd = datasetJsonLd(`${SITE_URL}${PAGE_PATH}`, PAGE_DESCRIPTION);
  const kpis = getSiteKpis();

  return (
    <article className="mx-auto max-w-3xl">
      <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Methodology
      </p>
      <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
        How the data gets from the DOL
        <br />
        to a search result.
      </h1>

      <section className="mt-10 space-y-6 text-lg leading-relaxed text-muted-foreground">
        <p>
          This page is the documentation that backs every number on h1b.report. It explains where
          the underlying records come from, how they are presented, and — just as importantly —
          what the data <em>does not</em> tell you. If you cite the site, this is the page to
          link.
        </p>
      </section>

      <h2 className="mt-16 text-2xl font-semibold tracking-tight">Data source</h2>
      <p className="mt-4 text-muted-foreground">
        Every record on this site originates from the{' '}
        <a
          href="https://www.dol.gov/agencies/eta/foreign-labor/performance"
          className="underline hover:text-foreground"
          target="_blank"
          rel="noopener noreferrer"
        >
          US Department of Labor, Office of Foreign Labor Certification (OFLC)
        </a>
        . OFLC publishes quarterly releases of every Labor Condition Application it received in
        the prior fiscal quarter, along with the final case status (Certified, Withdrawn,
        Certified-Withdrawn, Denied).
      </p>
      <p className="mt-4 text-muted-foreground">
        h1b.report covers every release back to fiscal year {kpis.first_year} — approximately{' '}
        {Math.round(kpis.total_records / 1e6)} million records across{' '}
        {kpis.canonical_employers.toLocaleString()}+ unique sponsoring employers and{' '}
        {kpis.distinct_socs} SOC occupation codes. New releases are picked up automatically within
        24 hours of DOL publication.
      </p>

      <h2 className="mt-16 text-2xl font-semibold tracking-tight">
        What an LCA is — and what it isn&apos;t
      </h2>
      <p className="mt-4 text-muted-foreground">
        A <strong className="text-foreground">Labor Condition Application</strong> is the form an
        employer files with the DOL before sponsoring an H-1B, H-1B1, or E-3 worker. By signing
        it, the employer attests to the offered wage, the worksite, the job title, and that the
        offered wage meets or exceeds the federal prevailing wage for the role and location.
      </p>
      <p className="mt-4 text-muted-foreground">
        An LCA is <strong className="text-foreground">not</strong> a visa, and a certified LCA is
        not an approved worker. After the LCA is certified, the employer must still file a Form
        I-129 petition with USCIS — and many certified LCAs never become petitions. h1b.report
        publishes the LCA layer because it is the only public, complete view of the program at
        the wage-and-employer level; USCIS petition outcomes are not released at the same
        granularity.
      </p>

      <h2 className="mt-16 text-2xl font-semibold tracking-tight">Our role</h2>
      <p className="mt-4 text-muted-foreground">
        The raw OFLC releases are denormalized spreadsheets: the same company appears under a
        dozen spellings, job titles are free-text, and the schema shifts every few years.
        h1b.report cleans up that surface — reconciling employer name variants into canonical
        organizations, mapping free-text job titles to a stable occupation taxonomy, and
        normalizing wages onto a single annual basis — so that every page on the site answers a
        question about the same underlying thing across every release.
      </p>
      <p className="mt-4 text-muted-foreground">
        Records that fail validation against the published DOL schema are held for review rather
        than silently dropped. Where automated classification is uncertain, the record is
        flagged for human review instead of being assigned a low-confidence label.
      </p>

      <h2 className="mt-16 text-2xl font-semibold tracking-tight">Wage methodology</h2>
      <p className="mt-4 text-muted-foreground">
        Employers may report wages as hourly, weekly, bi-weekly, monthly, or annual figures.
        Every wage on this site is normalized to <strong className="text-foreground">annual USD</strong>{' '}
        using the DOL&apos;s standard conversion (2,080 working hours per year for hourly wages).
        Where the employer reports a wage <em>range</em> rather than a single figure, h1b.report
        uses the lower bound, since that is the wage the employer is legally bound to.
      </p>
      <p className="mt-4 text-muted-foreground">
        The federal <strong className="text-foreground">prevailing wage</strong> is the wage paid
        to similarly employed workers in the geographic area of intended employment, derived from
        the BLS Occupational Employment Statistics (OES) survey and assigned at one of four
        skill levels:
      </p>
      <ul className="mt-4 space-y-2 text-muted-foreground">
        <li>
          <strong className="text-foreground">Level I — Entry.</strong> Workers with a basic
          understanding of duties, performing routine tasks with close supervision.
        </li>
        <li>
          <strong className="text-foreground">Level II — Qualified.</strong> Workers performing
          moderately complex tasks under general supervision.
        </li>
        <li>
          <strong className="text-foreground">Level III — Experienced.</strong> Workers using
          advanced skills, performing complex tasks with general direction.
        </li>
        <li>
          <strong className="text-foreground">Level IV — Fully competent.</strong> Workers
          applying advanced knowledge to plan, evaluate, and direct work.
        </li>
      </ul>
      <p className="mt-4 text-muted-foreground">
        Median and percentile wages shown on employer, occupation, and state pages are computed
        across <em>all</em> filings for that entity, regardless of level. Where a level breakdown
        is shown, it is computed within the level.
      </p>

      <h2 className="mt-16 text-2xl font-semibold tracking-tight">Known limitations</h2>
      <ul className="mt-4 space-y-3 text-muted-foreground">
        <li>
          <strong className="text-foreground">LCA ≠ visa approval.</strong> A certified LCA only
          means DOL approved the wage attestation. Whether the worker ultimately receives a visa
          is decided by USCIS in a separate I-129 process not visible in this dataset.
        </li>
        <li>
          <strong className="text-foreground">Duplicate filings per worker.</strong> Initial
          petitions, extensions, amendments, and transfers each generate a fresh LCA. h1b.report
          deduplicates by case number but does not attempt to deduplicate by underlying worker —
          that link is not in the data.
        </li>
        <li>
          <strong className="text-foreground">Worksite vs. headquarters.</strong> The
          &ldquo;state&rdquo; on an employer profile is the employer&apos;s registered state, not
          necessarily where the work happens. Per-filing worksite locations are shown on the
          individual filing view.
        </li>
        <li>
          <strong className="text-foreground">Withdrawn ≠ denied.</strong> A
          &ldquo;Withdrawn&rdquo; LCA was pulled by the employer, often because the role was
          filled domestically or the candidate dropped out. It is not a denial signal.
        </li>
      </ul>

      <h2 className="mt-16 text-2xl font-semibold tracking-tight">Licensing & reuse</h2>
      <p className="mt-4 text-muted-foreground">
        The underlying DOL releases are US-government public records, free of copyright. The
        derived data on this site — canonical employer mappings, occupation classifications, and
        roll-ups — is released under{' '}
        <a
          href="https://creativecommons.org/publicdomain/zero/1.0/"
          className="underline hover:text-foreground"
          target="_blank"
          rel="noopener noreferrer"
        >
          CC0 1.0
        </a>
        . You may mirror or republish without attribution; a link back is appreciated but not
        required.
      </p>

      <h2 className="mt-16 text-2xl font-semibold tracking-tight">Corrections</h2>
      <p className="mt-4 text-muted-foreground">
        Spotted a wrong canonical mapping, a misclassified occupation, or a wage that looks off?
        Email <a href="mailto:hello@h1b.report" className="underline hover:text-foreground">hello@h1b.report</a>{' '}
        with the URL and the issue. Corrections feed into the next quarterly rebuild.
      </p>

      <div className="mt-16 border-t pt-8">
        <Link href="/about" className="text-sm text-muted-foreground hover:text-foreground">
          ← About the project
        </Link>
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </article>
  );
}
