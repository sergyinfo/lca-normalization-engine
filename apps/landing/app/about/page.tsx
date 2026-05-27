/* SEO parity contract — keep this page and apps/analytics-web/app/about/page.tsx
   in sync (title, description, headings). Google will index this version first
   from the Cloudflare Pages deploy; the analytics-web version must serve the
   same URL with continuous content when AWS cutover happens, or rank is lost. */

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'About — the H-1B & LCA data project',
  description:
    'How h1b.report turns 12 million Labor Condition Applications from the US Department of Labor into a searchable, deduplicated database of US H-1B sponsors and salaries.',
  alternates: { canonical: 'https://h1b.report/about/' },
  openGraph: {
    title: 'About h1b.report',
    description:
      'How we turn 12M Labor Condition Applications into a searchable database of US H-1B sponsors and salaries.',
    url: 'https://h1b.report/about/',
  },
};

export default function AboutPage() {
  return (
    <>
      <header className="border-b border-[color:var(--color-border)]">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
          <Link href="/" className="font-display text-base font-semibold tracking-tight !text-[color:var(--color-fg)] no-underline">
            h1b<span className="text-[color:var(--color-accent)]">.report</span>
          </Link>
          <a
            href="mailto:hello@h1b.report?subject=Notify%20me%20when%20h1b.report%20launches"
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)] px-3 py-1.5 text-sm !text-[color:var(--color-fg)] no-underline hover:border-[color:var(--color-accent)]"
          >
            Get launch notice
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-16">
        <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-[color:var(--color-fg-muted)]">
          About
        </p>
        <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
          A public mirror of US H-1B salary data,<br />built for speed and honesty.
        </h1>

        <section className="mt-10 space-y-6 text-lg leading-relaxed text-[color:var(--color-fg-muted)]">
          <p>
            The US Department of Labor publishes every certified Labor Condition Application (LCA) it receives — the form
            an employer must file before sponsoring an H-1B, H-1B1, or E-3 worker. The raw releases are quarterly
            spreadsheets totalling tens of gigabytes, with no consistent employer naming, no canonical job-title
            taxonomy, and a schema that changes every few years.
          </p>
          <p>
            <strong className="text-[color:var(--color-fg)]">h1b.report</strong> takes those releases and turns them into
            something a human can actually use: search any company in milliseconds, see every role and worksite, compare
            wages against the federal prevailing-wage tiers, and read trend lines back to fiscal year 2002.
          </p>
        </section>

        <h2 className="mt-16 text-2xl font-semibold tracking-tight">What we do with the data</h2>
        <p className="mt-4 text-[color:var(--color-fg-muted)]">
          Every quarterly DOL release is ingested as soon as it&apos;s published, validated against the published
          schema, and reconciled with the previous corpus. Employer names are collapsed to canonical organizations so
          &ldquo;Google Inc.&rdquo;, &ldquo;Google LLC&rdquo;, and &ldquo;GOOGLE INC&rdquo; resolve to one entity.
          Free-text job titles are mapped to the Bureau of Labor Statistics SOC taxonomy. Wages are normalized to annual
          USD across all reporting units. The cleaned dataset is then served as a fast, indexable web app — with the
          full methodology, caveats, and known limitations documented on the{' '}
          <Link href="/methodology/">methodology page</Link>.
        </p>

        <h2 className="mt-16 text-2xl font-semibold tracking-tight">Who this is for</h2>
        <ul className="mt-6 space-y-4 text-[color:var(--color-fg-muted)]">
          <li>
            <strong className="text-[color:var(--color-fg)]">Workers</strong> deciding whether an offer is competitive
            against actual filed wages for their role and location.
          </li>
          <li>
            <strong className="text-[color:var(--color-fg)]">Researchers</strong> studying immigration policy,
            wage-suppression hypotheses, or industry concentration of foreign labor.
          </li>
          <li>
            <strong className="text-[color:var(--color-fg)]">Journalists</strong> tracking which companies sponsor most,
            where wage trends diverge from the prevailing rate, and how the program shifts year to year.
          </li>
          <li>
            <strong className="text-[color:var(--color-fg)]">Employers</strong> benchmarking offered salaries against
            their peer set before filing.
          </li>
        </ul>

        <h2 className="mt-16 text-2xl font-semibold tracking-tight">What it isn&apos;t</h2>
        <p className="mt-4 text-[color:var(--color-fg-muted)]">
          h1b.report does not show approved visa petitions, individual worker names, or any data the Department of Labor
          itself does not publish. It is not affiliated with the US government, USCIS, or DOL. It is a re-presentation
          of public data under the same disclosures the government already makes.
        </p>

        <h2 className="mt-16 text-2xl font-semibold tracking-tight">Get in touch</h2>
        <p className="mt-4 text-[color:var(--color-fg-muted)]">
          Questions, corrections, or research collaboration:{' '}
          <a href="mailto:hello@h1b.report">hello@h1b.report</a>.
        </p>

        <div className="mt-16 border-t border-[color:var(--color-border)] pt-8">
          <Link href="/" className="text-sm !text-[color:var(--color-fg-muted)] hover:!text-[color:var(--color-fg)]">
            ← Back to home
          </Link>
        </div>
      </main>
    </>
  );
}
