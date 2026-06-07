'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { useHomeYear } from '@/components/home/HomeYearContext';
import { pickScope, type Scoped, type HomeChartBundle } from '@/components/home/bundles';
import { fmt } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { HomeWageChartClient } from '@/components/charts/HomeWageChartClient';
import { DonutChartClient } from '@/components/charts/DonutChartClient';
import { HorizontalBarSvg } from '@/components/charts/HorizontalBarSvg';

export function HomeCharts({ bundles }: { bundles: Scoped<HomeChartBundle> }) {
  const { selected } = useHomeYear();
  const b = pickScope(bundles, selected);
  const scope = selected === 'all' ? 'across all fiscal years' : `in FY${selected}`;

  return (
    <>
      {/* ----- Highest-paying occupations ----- */}
      <section className="pt-12">
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Highest-paying H-1B occupations</CardTitle>
              <CardDescription>Median annual prevailing wage across the top 8 SOCs by wage, {scope}.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm" className="hidden md:inline-flex">
              <Link href="/highest-paying-h1b-jobs">Full ranking <ArrowRight className="size-3" /></Link>
            </Button>
          </CardHeader>
          <CardContent>
            {b.wage.length > 0
              ? <HomeWageChartClient data={b.wage} />
              : <p className="text-sm text-muted-foreground">No wage data for this year.</p>}
          </CardContent>
        </Card>
      </section>

      {/* ----- Industry mix + top states ----- */}
      <section className="grid lg:grid-cols-12 gap-6 pt-10">
        <Card className="lg:col-span-5">
          <CardHeader>
            <CardTitle>Industry mix</CardTitle>
            <CardDescription>Share of H-1B filings by NAICS 2-digit sector, {scope}.</CardDescription>
          </CardHeader>
          <CardContent>
            <DonutChartClient data={b.donut} size={220} centerLabel="filings" centerValue={fmt(b.donutTotal)} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-7">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Top hiring states</CardTitle>
              <CardDescription>Filings by worksite state, {scope}.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm" className="hidden md:inline-flex">
              <Link href="/top-h1b-states">Full ranking <ArrowRight className="size-3" /></Link>
            </Button>
          </CardHeader>
          <CardContent>
            <HorizontalBarSvg data={b.states} labelWidth={150} rowHeight={26}
              gradient={['hsl(217 91% 55%)', 'hsl(190 95% 50%)']} />
          </CardContent>
        </Card>
      </section>
    </>
  );
}
