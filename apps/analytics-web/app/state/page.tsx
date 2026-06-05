import type { Metadata } from 'next';
import { MapPin } from 'lucide-react';

import {
  listTopStates,
  getStateYearlyAll,
  getStateTopEmployers,
  getEntitySummary,
} from '@/lib/queries';
import { entityMetadata } from '@/lib/seo';
import { Badge } from '@/components/ui/badge';
import { Summary } from '@/components/Summary';
import { StateExplorer, type StateExplorerRow } from '@/components/StateExplorer';
import { AdSlot } from '@/components/AdSlot';

export const metadata: Metadata = entityMetadata({
  title: 'H-1B Filings by State',
  description:
    'H-1B sponsorship volume by US state. Choropleth map, region rollups, biggest YoY share movers, and per-100k-workers normalisation.',
  path: '/state',
});

export default function StateIndex() {
  const rows = listTopStates(60);
  const spark = getStateYearlyAll();
  const summary = getEntitySummary('index', 'state');

  const explorerRows: StateExplorerRow[] = rows.map((s) => {
    const top = getStateTopEmployers(s.code)[0];
    return {
      code: s.code,
      slug: s.slug,
      name: s.name,
      filings: s.filings,
      rank: s.rank,
      yearly: spark.byKey.get(s.code) ?? [],
      topSponsor: top
        ? { name: top.canonical_name, slug: top.employer_slug }
        : undefined,
    };
  });

  return (
    <>
      <section className="space-y-3 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <MapPin className="size-3" /> State index
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          H-1B filings by US state
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          Worksite-state distribution of H-1B Labor Condition Applications.
          Filter by region, switch between absolute filings and per-100k-workers,
          and see which states are gaining or losing share year over year.
        </p>
      </section>

      <Summary summary={summary} />

      <AdSlot name="state-index-top" />

      <StateExplorer rows={explorerRows} years={spark.years} />
    </>
  );
}
