import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Building2, Briefcase, MapPin, Factory } from 'lucide-react';

import { archiveExists, listArchives, validateLabel } from '@/lib/archive';
import { withArchiveDb } from '@/lib/db';
import { getSiteKpis, listTopEmployers, listTopOccupations, listTopStates, listTopSectors } from '@/lib/queries';
import { fmt, fmtUsd } from '@/lib/format';
import { ArchiveBanner } from '@/components/ArchiveBanner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export const dynamicParams = true;

export function generateStaticParams() {
  return listArchives().map((a) => ({ label: a.label }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ label: string }> },
): Promise<Metadata> {
  const { label } = await params;
  if (!validateLabel(label) || !archiveExists(label)) return { title: 'Not found' };
  const display = label.replace(/^(\d{4})-q(\d)$/, '$1 Q$2');
  return {
    title: `${display} archive`,
    description: `Frozen H-1B / LCA data snapshot from ${display}.`,
    robots: { index: false, follow: true },
    alternates: { canonical: '/' },
  };
}

export default async function ArchiveLabelPage(
  { params }: { params: Promise<{ label: string }> },
) {
  const { label } = await params;
  if (!validateLabel(label) || !archiveExists(label)) notFound();

  return withArchiveDb(label, () => renderArchiveHome(label));
}

function renderArchiveHome(label: string) {
  const kpis        = getSiteKpis();
  const employers   = listTopEmployers(10);
  const occupations = listTopOccupations(10);
  const states      = listTopStates(10);
  const sectors     = listTopSectors(10);

  return (
    <>
      <ArchiveBanner label={label} livePath="/" />

      <section className="space-y-3 pb-6">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          Archive snapshot · {label.replace(/^(\d{4})-q(\d)$/, '$1 Q$2')}
        </h1>
        <p className="text-muted-foreground max-w-3xl">
          A frozen view of the dataset as of this quarter. All links below
          stay inside the archive so the cross-references reflect the
          snapshot.
        </p>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 pb-8">
        <KpiTile label="Disclosures" value={fmt(kpis.total_records)} />
        <KpiTile label="Sponsors"    value={fmt(kpis.canonical_employers)} />
        <KpiTile label="Occupations" value={fmt(kpis.distinct_socs)} />
        <KpiTile label="Median wage" value={fmtUsd(kpis.median_wage)} />
      </section>

      <div className="grid md:grid-cols-2 gap-4">
        <TopList label={label} kind="employer"   icon={Building2} title="Top 10 sponsors"     rows={employers.map(e => ({ slug: e.slug, primary: e.canonical_name, value: e.filings }))} />
        <TopList label={label} kind="occupation" icon={Briefcase} title="Top 10 occupations" rows={occupations.map(o => ({ slug: o.slug, primary: o.soc_title ?? o.soc_code, value: o.filings }))} />
        <TopList label={label} kind="state"      icon={MapPin}    title="Top 10 states"       rows={states.map(s => ({ slug: s.slug, primary: s.name, value: s.filings }))} />
        <TopList label={label} kind="sector"     icon={Factory}   title="Top 10 sectors"      rows={sectors.map(s => ({ slug: s.slug, primary: s.label, value: s.filings }))} />
      </div>
    </>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-2xl font-bold tabular-nums leading-none">{value}</div>
      </CardContent>
    </Card>
  );
}

function TopList({
  label, kind, icon: Icon, title, rows,
}: {
  label: string;
  kind: 'employer' | 'occupation' | 'state' | 'sector';
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  rows: Array<{ slug: string; primary: string; value: number }>;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Icon className="size-4 text-primary" /> {title}
        </CardTitle>
        <CardDescription>Click any row for the archived entity page.</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Filings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.slug}>
                <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                <TableCell>
                  <Link
                    href={`/archive/${label}/${kind}/${r.slug}`}
                    className="font-medium hover:text-primary"
                  >
                    {r.primary}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.value)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
