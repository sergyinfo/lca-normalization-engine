import Link from 'next/link';
import type { Metadata } from 'next';
import { Archive } from 'lucide-react';

import { listArchives } from '@/lib/archive';
import { SITE_NAME } from '@/lib/site';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = {
  title: 'Archives',
  description: `Frozen quarterly snapshots of the ${SITE_NAME} dataset. Each archive captures the top sponsors, occupations, states, and sectors at the moment of build, preserving content for historical reference.`,
  robots: { index: false, follow: true },
  alternates: { canonical: '/archive' },
};

export default function ArchiveIndexPage() {
  const archives = listArchives();
  return (
    <>
      <section className="space-y-3 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Archive className="size-3" /> Snapshots
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          Quarterly archives
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          Each rebuild of the {SITE_NAME} dataset is preserved here as a
          read-only snapshot. Use these for citations, historical research,
          or to compare how the H-1B landscape has shifted between quarters.
        </p>
      </section>

      {archives.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No archived snapshots yet. The first one will appear after the next data rebuild.
          </CardContent>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {archives.map((a) => (
            <Link key={a.label} href={`/archive/${a.label}`}>
              <Card className="h-full transition-all hover:border-primary/30 hover:shadow-md hover:-translate-y-0.5">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">{a.display}</CardTitle>
                  <CardDescription>
                    Generated {new Date(a.generatedAt * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {(a.bytes / 1024).toFixed(0)} KB snapshot
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
