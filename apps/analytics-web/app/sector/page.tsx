import type { Metadata } from 'next';
import { Factory } from 'lucide-react';

import { listTopSectors, getSectorYearlyAll, getEntitySummary } from '@/lib/queries';
import { entityMetadata } from '@/lib/seo';
import { Badge } from '@/components/ui/badge';
import { Summary } from '@/components/Summary';
import {
  SectorExplorer,
  type SectorExplorerRow,
} from '@/components/SectorExplorer';
import { AdSlot } from '@/components/AdSlot';

export const metadata: Metadata = entityMetadata({
  title: 'H-1B Filings by Industry Sector',
  description:
    'H-1B sponsorship grouped by NAICS 2-digit sector. KPI summary, biggest YoY share movers, and a searchable sortable table of every sector covered.',
  path: '/sector',
});

export default function SectorIndex() {
  const rows = listTopSectors(60);
  const spark = getSectorYearlyAll();
  const summary = getEntitySummary('index', 'sector');

  const explorerRows: SectorExplorerRow[] = rows.map((s) => ({
    naics2: s.naics2,
    slug: s.slug,
    label: s.label,
    filings: s.filings,
    employers: s.employers,
    rank: s.rank,
    yearly: spark.byKey.get(s.naics2) ?? [],
  }));

  return (
    <>
      <section className="space-y-3 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Factory className="size-3" /> Industry sectors
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          H-1B filings by industry sector
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          NAICS 2-digit sector breakdown of H-1B Labor Condition Applications.
          See which sectors are gaining or losing share of national hiring, and
          search the full list by code or label.
        </p>
      </section>

      <Summary summary={summary} />

      <AdSlot name="sector-index-top" />

      <SectorExplorer rows={explorerRows} years={spark.years} />
    </>
  );
}
