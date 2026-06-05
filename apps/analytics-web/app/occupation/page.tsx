import type { Metadata } from 'next';
import { Briefcase } from 'lucide-react';

import { listTopOccupations, getOccupationYearlyAll, getEntitySummary } from '@/lib/queries';
import { entityMetadata } from '@/lib/seo';
import { Badge } from '@/components/ui/badge';
import { Summary } from '@/components/Summary';
import {
  OccupationExplorer,
  type OccupationExplorerRow,
} from '@/components/OccupationExplorer';
import { AdSlot } from '@/components/AdSlot';

export const metadata: Metadata = entityMetadata({
  title: 'H-1B Occupations — Salary Guide Index',
  description:
    'Browse H-1B occupations by SOC code. KPI summary, biggest YoY share movers, prevailing-wage medians, and a searchable sortable table of every occupation in the corpus.',
  path: '/occupation',
});

export default function OccupationIndex() {
  const rows = listTopOccupations(500);
  const spark = getOccupationYearlyAll();
  const summary = getEntitySummary('index', 'occupation');

  const explorerRows: OccupationExplorerRow[] = rows.map((o) => ({
    soc_code: o.soc_code,
    slug: o.slug,
    soc_title: o.soc_title,
    filings: o.filings,
    p50_wage: o.p50_wage,
    rank: o.rank,
    yearly: spark.byKey.get(o.soc_code) ?? [],
  }));

  return (
    <>
      <section className="space-y-3 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Briefcase className="size-3" /> Occupation salary guides
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          H-1B occupations by filing volume
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          SOC-coded occupations covered by the H-1B program. See which roles
          are gaining or losing share year over year, and search across all
          500 codes by SOC number or job title.
        </p>
      </section>

      <Summary summary={summary} />

      <AdSlot name="occupation-index-top" />

      <OccupationExplorer rows={explorerRows} years={spark.years} />
    </>
  );
}
