import type { Metadata } from 'next';
import Link from 'next/link';
import Script from 'next/script';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Search } from 'lucide-react';
import './globals.css';

import { SITE_NAME, SITE_URL, GTM_ID } from '@/lib/site';
import { FEATURES } from '@/lib/features';
import { ADSENSE_CLIENT_ID } from '@/lib/adsense';
import { getSiteKpis } from '@/lib/queries';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MobileNav } from '@/components/MobileNav';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — H-1B & LCA Data, Salaries, Sponsors`,
    template: `%s · ${SITE_NAME}`,
  },
  description:
    'Free deep-dives into US H-1B sponsorship: per-employer profiles, occupation salary guides, state breakdowns, denial-rate trends. Built on the DOL Labor Condition Application disclosures.',
  alternates: { canonical: '/' },
  openGraph: { type: 'website', siteName: SITE_NAME, locale: 'en_US' },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
};

const navLinks = [
  { href: '/employer',   label: 'Sponsors' },
  { href: '/occupation', label: 'Occupations' },
  { href: '/state',      label: 'States' },
  { href: '/sector',     label: 'Sectors' },
  { href: '/rankings',   label: 'Rankings' },
  ...(FEATURES.api ? [{ href: '/api/docs', label: 'API' }] : []),
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={cn(GeistSans.variable, GeistMono.variable)} suppressHydrationWarning>
      <head>
        {GTM_ID ? (
          <Script id="gtm-loader" strategy="afterInteractive">
            {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${GTM_ID}');`}
          </Script>
        ) : null}
        {ADSENSE_CLIENT_ID ? (
          <>
            <meta name="google-adsense-account" content={ADSENSE_CLIENT_ID} />
            <Script
              id="adsbygoogle-loader"
              async
              src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`}
              crossOrigin="anonymous"
              strategy="afterInteractive"
            />
          </>
        ) : null}
      </head>
      <body className="font-sans antialiased min-h-screen flex flex-col bg-background text-foreground">
        {GTM_ID ? (
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
              height="0"
              width="0"
              style={{ display: 'none', visibility: 'hidden' }}
            />
          </noscript>
        ) : null}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <SiteHeader />
          <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-8 md:py-12">
            {children}
          </main>
          <SiteFooter />
        </ThemeProvider>
      </body>
    </html>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="text-base font-semibold tracking-tight">
          {SITE_NAME}
        </Link>
        <nav className="hidden md:flex items-center gap-5 text-sm">
          {navLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <form
          method="get"
          action="/search"
          role="search"
          aria-label="Search the site"
          className="ml-auto relative w-full max-w-xs"
        >
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            name="q"
            placeholder="Search sponsors, jobs, states…"
            aria-label="Search"
            minLength={2}
            className="h-9 pl-8"
          />
        </form>
        <ThemeToggle />
        <MobileNav links={navLinks} />
      </div>
    </header>
  );
}

function SiteFooter() {
  let yearRange = '';
  try { const k = getSiteKpis(); yearRange = `, FY${k.first_year}–FY${k.last_year}`; } catch { /* lca.db unavailable in this render context */ }
  return (
    <footer className="border-t bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-8 text-xs text-muted-foreground space-y-2">
        <p>
          Data sourced from the US Department of Labor Office of Foreign
          Labor Certification (LCA disclosures{yearRange}). This site is
          independent and not affiliated with the DOL.
        </p>
        <p className="flex gap-3">
          <Link href="/about" className="hover:text-foreground">About</Link>
          <span aria-hidden>·</span>
          <Link href="/methodology" className="hover:text-foreground">Methodology</Link>
          <span aria-hidden>·</span>
          <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
          <span aria-hidden>·</span>
          <Link href="/h1b-forecast" className="hover:text-foreground">H-1B Forecast</Link>
          {FEATURES.api ? (
            <>
              <span aria-hidden>·</span>
              <Link href="/api/docs" className="hover:text-foreground">Data API</Link>
            </>
          ) : null}
        </p>
      </div>
    </footer>
  );
}
