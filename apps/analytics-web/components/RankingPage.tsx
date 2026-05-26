/**
 * Shared template for ranked "best of" landing pages. Each instance is a
 * thin page.tsx that picks the dataset + columns and hands them here.
 *
 * SEO design notes:
 *   - H1 includes the FY suffix so the page reads as a 2025 ranking,
 *     even though the URL stays evergreen.
 *   - ItemList JSON-LD makes the page eligible for ranked-list rich results.
 *   - Ad slot is placed mid-page (between intro and table) — typical RPM
 *     is 2-3x higher than top/bottom on ranking content.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, Trophy } from 'lucide-react';

import { fmt } from '@/lib/format';
import { itemListJsonLd } from '@/lib/seo';
import { SITE_URL } from '@/lib/site';
import { AdSlot } from '@/components/AdSlot';
import { Badge } from '@/components/ui/badge';
import { MiniBar } from '@/components/charts/MiniBar';
import { PageMinimap } from '@/components/PageMinimap';
import { PaginatedRankingTable } from '@/components/PaginatedRankingTable';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';

export interface RankingCell {
  label: string;
  value: ReactNode;
  numeric?: boolean;
  /** Stable column key — required to make this column sortable. */
  sortKey?: string;
  /** Sort type. Defaults to 'string'. */
  sortType?: 'number' | 'string';
  /** Raw value for sorting (avoids parsing formatted strings). */
  sortValue?: string | number | null;
}

export interface RankingRow {
  rank: number;
  href: string;         // internal URL, e.g. /employer/cognizant-...
  primary: string;      // entity name
  cells: RankingCell[];
}

interface Props {
  eyebrow: string;
  title: string;          // base title without year — we append it below
  fiscalYear: number;     // typically kpis.last_year
  intro: ReactNode;
  rows: RankingRow[];
  methodology: ReactNode;
  adSlotName: string;
  /** Optional href + label for a back link at the top. */
  back?: { href: string; label: string };
  /**
   * Optional pre-table visualisation. Renders inside its own Card directly
   * above the ranked table. Use for "Top 10 leaderboard at a glance"
   * horizontal bars + distribution histograms.
   */
  preTableVisual?: ReactNode;
}

export function RankingPage({
  eyebrow, title, fiscalYear, intro, rows, methodology, adSlotName, back,
  preTableVisual,
}: Props) {
  return (
    <>
      {back ? (
        <nav aria-label="Breadcrumb" className="pb-2">
          <Link
            href={back.href}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            {back.label}
          </Link>
        </nav>
      ) : null}

      <PageMinimap />

      {/* Hero */}
      <section
        className="space-y-4 pb-6"
        data-section-id="hero"
        data-section-label="Overview"
      >
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Trophy className="size-3" />
          {eyebrow} · FY{fiscalYear}
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight max-w-4xl">
          {title}{' '}
          <span className="text-muted-foreground">FY{fiscalYear}</span>
        </h1>
        <div className="text-muted-foreground max-w-3xl">{intro}</div>
      </section>

      <AdSlot name={adSlotName} />

      {preTableVisual ? (
        <div
          className="pt-2"
          data-section-id="visual"
          data-section-label="Visual summary"
        >
          {preTableVisual}
        </div>
      ) : null}

      <PaginatedRankingTable rows={rows} />

      {/* Methodology */}
      <Card
        className="mt-6 bg-muted/30"
        data-section-id="methodology"
        data-section-label="Methodology"
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Methodology
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground leading-relaxed">
          {methodology}
        </CardContent>
      </Card>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(itemListJsonLd(
            rows.map((r) => ({ url: `${SITE_URL}${r.href}`, name: r.primary })),
          )),
        }}
      />
    </>
  );
}

/** Helper for ranking pages that want a "N filings" numeric cell. */
export function filingsCell(n: number | bigint | null): RankingCell {
  return {
    label: 'Filings',
    value: fmt(n),
    numeric: true,
    sortKey: 'filings',
    sortType: 'number',
    sortValue: n == null ? null : Number(n),
  };
}

/**
 * Same as filingsCell, but renders an inline proportional MiniBar next to
 * the number — makes #1 vs #N visually obvious at a glance. Pass the column
 * max from the caller so every row stays in proportion.
 */
export function filingsCellWithBar(n: number | null, max: number): RankingCell {
  return {
    label: 'Filings',
    numeric: true,
    sortKey: 'filings',
    sortType: 'number',
    sortValue: n,
    value: (
      <span className="inline-flex items-center justify-end gap-2 w-full">
        <MiniBar value={n ?? 0} max={max} />
        <span className="tabular-nums">{fmt(n)}</span>
      </span>
    ),
  };
}

/** Re-export for callers that want to declare CardDescription bare. */
export { CardDescription };
