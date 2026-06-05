import type { Metadata } from 'next';
import Link from 'next/link';
import { entityMetadata } from '@/lib/seo';

export const metadata: Metadata = entityMetadata({
  title: 'Privacy Policy',
  description:
    'How h1b.report handles cookies, third-party advertising (Google AdSense), analytics, and server logs. The site shows only public US Department of Labor data and collects no personal account information.',
  path: '/privacy',
});

const UPDATED = 'June 5, 2026';
const CONTACT = 'hello@h1b.report';

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl">
      <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Privacy
      </p>
      <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
        Privacy Policy
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">Last updated: {UPDATED}</p>

      <div className="mt-10 space-y-8 text-base leading-relaxed text-muted-foreground [&_h2]:text-foreground [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_a]:underline [&_a:hover]:text-foreground">
        <section className="space-y-3">
          <p>
            <strong className="text-foreground">h1b.report</strong> (&ldquo;the site&rdquo;,
            &ldquo;we&rdquo;) is an independent, public reference built from US Department of Labor
            Labor Condition Application (LCA) disclosure data. This policy explains what information
            is collected when you visit, how it is used, and the choices you have.
          </p>
          <p>
            The site has no user accounts and does not ask you for personal information. The
            employer, wage, occupation, and worksite data shown is public record published by the
            Department of Labor, not information about you.
          </p>
        </section>

        <section className="space-y-3">
          <h2>Information collected automatically</h2>
          <p>
            Like most websites, our servers and content-delivery network record standard technical
            log data when a page is requested — IP address, browser type and version, the pages
            visited, and timestamps. This is used to operate the service, measure aggregate traffic,
            and detect abuse. We do not use it to identify you personally.
          </p>
        </section>

        <section className="space-y-3">
          <h2>Cookies</h2>
          <p>
            A cookie is a small file a site stores in your browser. We use cookies (and similar
            technologies) for two purposes: anonymous, aggregate analytics, and to serve advertising
            through third parties described below. You can block or delete cookies in your browser
            settings; the site will still work, though some preferences may not persist.
          </p>
        </section>

        <section className="space-y-3">
          <h2>Advertising (Google AdSense)</h2>
          <p>
            We use Google AdSense to display ads. Third-party vendors, including Google, use cookies
            to serve ads based on your prior visits to this and other websites.
          </p>
          <ul className="ml-5 list-disc space-y-2">
            <li>
              Google&rsquo;s use of advertising cookies enables it and its partners to serve ads to
              you based on your visits to this site and/or other sites on the Internet.
            </li>
            <li>
              You can opt out of personalized advertising by visiting{' '}
              <a href="https://www.google.com/settings/ads" target="_blank" rel="noopener noreferrer">
                Google Ads Settings
              </a>
              . You can also opt out of a third-party vendor&rsquo;s use of cookies for personalized
              advertising at{' '}
              <a href="https://www.aboutads.info/choices/" target="_blank" rel="noopener noreferrer">
                aboutads.info
              </a>
              .
            </li>
            <li>
              For more on how Google uses data when you use our partners&rsquo; sites or apps, see{' '}
              <a
                href="https://policies.google.com/technologies/partner-sites"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google&rsquo;s policy
              </a>
              .
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2>Analytics</h2>
          <p>
            We may use Google Analytics / Google Tag Manager to understand aggregate usage (which
            pages are popular, broad geographic and device breakdowns). These tools set cookies and
            process data per{' '}
            <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">
              Google&rsquo;s Privacy Policy
            </a>
            . The data is used in aggregate and is not combined with any attempt to identify
            individual visitors.
          </p>
        </section>

        <section className="space-y-3">
          <h2>Data we publish</h2>
          <p>
            The records shown on this site come exclusively from the Department of Labor&rsquo;s
            public LCA disclosure releases. We normalise and de-duplicate that public data; we do not
            add private or personal information to it. If you believe a record is inaccurate, the
            authoritative source and any corrections are the Department of Labor.
          </p>
        </section>

        <section className="space-y-3">
          <h2>Third-party links</h2>
          <p>
            Pages may link to external sites (e.g. the Department of Labor, employer websites). We are
            not responsible for the privacy practices of those sites; review their policies
            separately.
          </p>
        </section>

        <section className="space-y-3">
          <h2>Children</h2>
          <p>
            This site is not directed at children under 13 and does not knowingly collect personal
            information from them.
          </p>
        </section>

        <section className="space-y-3">
          <h2>Changes</h2>
          <p>
            We may update this policy as the site evolves or as required by law. Material changes will
            be reflected here with a new &ldquo;last updated&rdquo; date.
          </p>
        </section>

        <section className="space-y-3">
          <h2>Contact</h2>
          <p>
            Questions about this policy? Email{' '}
            <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          </p>
        </section>
      </div>

      <div className="mt-12 border-t pt-6 text-sm">
        <Link href="/about" className="text-muted-foreground hover:text-foreground">
          ← About this project
        </Link>
      </div>
    </article>
  );
}
