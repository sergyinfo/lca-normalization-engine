import Link from 'next/link';
import type { Metadata } from 'next';
import {
  Trophy, Building2, Briefcase, BadgeDollarSign, MapPin, Factory, ShieldCheck,
} from 'lucide-react';

import { entityMetadata } from '@/lib/seo';
import { getSiteKpis } from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = entityMetadata({
  title: 'Rankings',
  description:
    'Ranked lists of H-1B sponsors, occupations, and states — top filers, highest-paying jobs, cleanest certification records, and more.',
  path: '/rankings',
});

interface RankingMeta {
  href: string;
  title: string;
  teaser: string;
  icon: React.ComponentType<{ className?: string }>;
}

const RANKINGS: RankingMeta[] = [
  {
    href:  '/top-h1b-sponsors',
    title: 'Top 100 H-1B Sponsors',
    teaser: 'Highest-volume canonical sponsors by total Labor Condition Applications filed.',
    icon:  Building2,
  },
  {
    href:  '/top-h1b-occupations',
    title: 'Top H-1B Occupations',
    teaser: 'SOC codes with the largest share of H-1B filings — what the program is actually hiring.',
    icon:  Briefcase,
  },
  {
    href:  '/highest-paying-h1b-jobs',
    title: 'Highest-Paying H-1B Jobs',
    teaser: 'Occupations ranked by median annual prevailing wage. Where the program pays best.',
    icon:  BadgeDollarSign,
  },
  {
    href:  '/top-h1b-states',
    title: 'Top H-1B States',
    teaser: 'US states by worksite filing volume.',
    icon:  MapPin,
  },
  {
    href:  '/h1b-by-industry',
    title: 'H-1B by Industry (NAICS)',
    teaser: 'Sectoral breakdown of where H-1B sponsorship concentrates.',
    icon:  Factory,
  },
  {
    href:  '/cleanest-h1b-sponsors',
    title: 'Cleanest H-1B Sponsors',
    teaser: 'Large sponsors with the highest certification rate — the closest thing to a "good-sponsor" leaderboard.',
    icon:  ShieldCheck,
  },
];

export default function RankingsIndex() {
  const kpis = getSiteKpis();
  return (
    <>
      <section className="space-y-3 pb-8">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Trophy className="size-3" /> Rankings · FY{kpis.last_year}
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          H-1B rankings <span className="text-muted-foreground">FY{kpis.last_year}</span>
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          Curated leaderboards over the normalised LCA corpus. Each list is
          regenerated quarterly from the same data the entity pages use.
        </p>
      </section>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {RANKINGS.map((r) => {
          const Icon = r.icon;
          return (
            <Link key={r.href} href={r.href} className="group">
              <Card className="h-full transition-all hover:border-primary/30 hover:shadow-md hover:-translate-y-0.5">
                <CardContent className="p-5 flex flex-col gap-3">
                  <div className="size-10 rounded-md bg-secondary flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                    <Icon className="size-5" />
                  </div>
                  <div className="space-y-1">
                    <div className="font-semibold">{r.title} →</div>
                    <div className="text-sm text-muted-foreground leading-relaxed">{r.teaser}</div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </>
  );
}
