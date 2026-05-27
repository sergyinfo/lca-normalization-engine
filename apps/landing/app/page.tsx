import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'H-1B salaries, employers & LCA data — launching 2026',
  description:
    'Search 12 million+ certified Labor Condition Applications from the US Department of Labor. Free, fast, and open. Coming late 2026.',
  alternates: { canonical: 'https://h1b.report' },
  openGraph: {
    title: 'h1b.report — H-1B salaries, employers & LCA data',
    description:
      'A free, searchable database of US H-1B Labor Condition Applications. 12 million records, 2002–present.',
    url: 'https://h1b.report',
  },
};

const STATS = [
  { value: '12.1M+', label: 'Certified LCAs since 2002' },
  { value: '420k+',  label: 'Unique sponsoring employers' },
  { value: '825',    label: 'SOC occupation codes covered' },
  { value: '50+1',   label: 'US states & DC, plus territories' },
];

const FEATURES = [
  {
    title: 'Search any employer',
    body: 'Filed LCAs by year, role, worksite, and prevailing wage tier — normalized across name variants so "Google Inc.", "Google LLC", and "GOOGLE INC" collapse to one entity.',
  },
  {
    title: 'Compare salaries by role',
    body: 'Median, 25th and 75th percentile wages for every SOC code, broken down by state, metro, and experience level.',
  },
  {
    title: 'Track sponsor trends',
    body: 'See which companies are scaling H-1B hiring, which roles dominate each industry, and how wages move quarter over quarter.',
  },
  {
    title: 'Open & free',
    body: 'No paywall, no signup gate, no scraping limits on the public search. Built as a public-interest resource for workers, researchers, and journalists.',
  },
];

const ABOUT_PARAGRAPHS = [
  'Every year US employers file roughly 700,000 Labor Condition Applications with the Department of Labor before sponsoring an H-1B, H-1B1, or E-3 worker. Each LCA discloses the offered wage, the worksite, the job title, and the prevailing wage for the role — a near-complete public record of how foreign-skilled labor is priced in the US economy.',
  'The DOL publishes this data quarterly as denormalized spreadsheets. h1b.report takes every release back to 2002, reconciles the long tail of employer name variants into canonical organizations, classifies free-text job titles against the BLS SOC taxonomy, and serves the result as a fast, indexable search experience.',
];

export default function HomePage() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-6 pb-32 pt-12 sm:pt-20">
        <Hero />
        <StatsBlock />
        <FeaturesBlock />
        <AboutBlock />
        <CtaBlock />
      </main>
      <Footer />
    </>
  );
}

function Header() {
  return (
    <header className="border-b border-[color:var(--color-border)]">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <Link href="/" className="font-display text-base font-semibold tracking-tight !text-[color:var(--color-fg)] no-underline">
          h1b<span className="text-[color:var(--color-accent)]">.report</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <Link href="/about/" className="!text-[color:var(--color-fg-muted)] hover:!text-[color:var(--color-fg)] no-underline">
            About
          </Link>
          <a
            href="mailto:hello@h1b.report?subject=Notify%20me%20when%20h1b.report%20launches"
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)] px-3 py-1.5 !text-[color:var(--color-fg)] no-underline hover:border-[color:var(--color-accent)]"
          >
            Get launch notice
          </a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="pb-16 pt-12 sm:pb-20 sm:pt-16">
      <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)] px-3 py-1 text-xs font-medium uppercase tracking-wider text-[color:var(--color-fg-muted)]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--color-accent)]" />
        Launching late 2026
      </p>
      <h1 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
        Every <span className="text-[color:var(--color-accent)]">H-1B salary</span>,<br />
        every sponsoring employer,<br />
        one fast search.
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-[color:var(--color-fg-muted)] sm:text-xl">
        A free, open database of <strong className="text-[color:var(--color-fg)]">12&nbsp;million&nbsp;Labor Condition Applications</strong>{' '}
        filed with the US Department of Labor since 2002 — normalized, deduplicated, and ready to answer the questions
        the raw DOL spreadsheets cannot.
      </p>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
        <a
          href="mailto:hello@h1b.report?subject=Notify%20me%20when%20h1b.report%20launches"
          className="inline-flex items-center justify-center rounded-md bg-[color:var(--color-accent)] px-5 py-3 text-sm font-semibold !text-black no-underline hover:opacity-90"
        >
          Email me at launch →
        </a>
        <Link
          href="/about/"
          className="inline-flex items-center justify-center rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)] px-5 py-3 text-sm font-medium !text-[color:var(--color-fg)] no-underline hover:border-[color:var(--color-fg-muted)]"
        >
          What we&apos;re building
        </Link>
      </div>

      <p className="mt-6 text-sm text-[color:var(--color-fg-dim)]">
        No newsletter, no marketing. One email when the search goes live.
      </p>
    </section>
  );
}

function StatsBlock() {
  return (
    <section aria-label="Dataset overview" className="border-y border-[color:var(--color-border)] py-12">
      <h2 className="mb-8 text-sm font-semibold uppercase tracking-[0.18em] text-[color:var(--color-fg-muted)]">
        The dataset, at a glance
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4">
        {STATS.map((s) => (
          <div key={s.label}>
            <dt className="font-mono text-3xl font-medium tracking-tight text-[color:var(--color-fg)] sm:text-4xl">
              {s.value}
            </dt>
            <dd className="mt-2 text-sm leading-snug text-[color:var(--color-fg-muted)]">{s.label}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-8 text-xs leading-relaxed text-[color:var(--color-fg-dim)]">
        Source: US Department of Labor, Office of Foreign Labor Certification (OFLC) quarterly disclosure releases,
        fiscal years 2002 through Q2 2026. Figures rounded.
      </p>
    </section>
  );
}

function FeaturesBlock() {
  return (
    <section aria-label="What's coming" className="py-16">
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">What&apos;s coming</h2>
      <p className="mt-3 max-w-2xl text-[color:var(--color-fg-muted)]">
        The first public release will cover search, employer profiles, salary comparisons, and
        state-by-state breakdowns.
      </p>
      <ul className="mt-10 grid gap-px overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-border)] sm:grid-cols-2">
        {FEATURES.map((f) => (
          <li key={f.title} className="bg-[color:var(--color-bg-card)] p-6">
            <h3 className="font-display text-lg font-semibold text-[color:var(--color-fg)]">{f.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-fg-muted)]">{f.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AboutBlock() {
  return (
    <section id="about" aria-label="About the project" className="border-t border-[color:var(--color-border)] py-16">
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Why this exists</h2>
      <div className="mt-6 space-y-5 text-[color:var(--color-fg-muted)]">
        {ABOUT_PARAGRAPHS.map((p, i) => (
          <p key={i} className="max-w-3xl leading-relaxed">
            {p}
          </p>
        ))}
      </div>
      <p className="mt-6 max-w-3xl leading-relaxed text-[color:var(--color-fg-muted)]">
        Read more <Link href="/about/">about the project and methodology →</Link>
      </p>
    </section>
  );
}

function CtaBlock() {
  return (
    <section
      aria-label="Stay informed"
      className="mt-16 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)] p-8 sm:p-12"
    >
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Be there for the launch</h2>
      <p className="mt-3 max-w-xl text-[color:var(--color-fg-muted)]">
        We&apos;ll email you exactly once — the day the public search goes live. No newsletter,
        no marketing list, no sharing.
      </p>
      <a
        href="mailto:hello@h1b.report?subject=Notify%20me%20when%20h1b.report%20launches&body=Hi%20%E2%80%94%20please%20add%20me%20to%20the%20launch%20list.%20Thanks!"
        className="mt-6 inline-flex items-center justify-center rounded-md bg-[color:var(--color-accent)] px-5 py-3 text-sm font-semibold !text-black no-underline hover:opacity-90"
      >
        hello@h1b.report
      </a>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[color:var(--color-border)] py-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 text-sm text-[color:var(--color-fg-dim)] sm:flex-row sm:items-center sm:justify-between">
        <p>
          © {new Date().getUTCFullYear()} h1b.report. Not affiliated with the US government.
          Data sourced from public DOL OFLC disclosure releases.
        </p>
        <nav className="flex gap-5">
          <Link href="/about/" className="!text-[color:var(--color-fg-muted)] hover:!text-[color:var(--color-fg)] no-underline">
            About
          </Link>
          <a href="mailto:hello@h1b.report" className="!text-[color:var(--color-fg-muted)] hover:!text-[color:var(--color-fg)] no-underline">
            Contact
          </a>
        </nav>
      </div>
    </footer>
  );
}
