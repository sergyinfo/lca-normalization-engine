import type { Metadata } from 'next';
import { Building2 } from 'lucide-react';

import { listTopEmployers, getEmployerYearlyAll } from '@/lib/queries';
import { entityMetadata } from '@/lib/seo';
import { Badge } from '@/components/ui/badge';
import {
  EmployerExplorer,
  type EmployerExplorerRow,
} from '@/components/EmployerExplorer';

export const metadata: Metadata = entityMetadata({
  title: 'Top H-1B Sponsors — Employer Index',
  description:
    'Browse the largest H-1B sponsors in the United States. KPI summary, biggest YoY share movers, certification rates, and a searchable sortable table of every sponsor in the corpus.',
  path: '/employer',
});

export default function EmployerIndex() {
  const employers = listTopEmployers(500);
  const spark = getEmployerYearlyAll();

  const explorerRows: EmployerExplorerRow[] = employers.map((e) => ({
    slug: e.slug,
    canonical_name: e.canonical_name,
    employer_state: e.employer_state,
    filings: e.filings,
    certified_pct: e.certified_pct,
    denied_pct: e.denied_pct,
    rank: e.rank!,  // listTopEmployers filters by rank IS NOT NULL
    yearly: spark.byKey.get(e.slug) ?? [],
  }));

  return (
    <>
      <section className="space-y-3 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Building2 className="size-3" /> Sponsor index
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          H-1B sponsors by filing volume
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          Every employer that filed an H-1B Labor Condition Application in
          the covered fiscal years. See which sponsors are gaining or losing
          share year over year, and search by company name or state code.
        </p>
      </section>

      <EmployerExplorer rows={explorerRows} years={spark.years} />
    </>
  );
}
