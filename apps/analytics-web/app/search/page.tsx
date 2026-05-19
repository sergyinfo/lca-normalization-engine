import Link from 'next/link';
import type { Metadata } from 'next';
import { Search as SearchIcon } from 'lucide-react';

import { searchAll, type SearchHit } from '@/lib/search';
import { fmt } from '@/lib/format';
import { entityMetadata } from '@/lib/seo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = entityMetadata({
  title: 'Search',
  description:
    'Search H-1B sponsors, occupations, US states, and NAICS sectors covered in the dataset.',
  path: '/search',
});

export default async function SearchPage(
  { searchParams }: { searchParams: Promise<{ q?: string }> },
) {
  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const results = q.length >= 2 ? searchAll(q) : [];

  return (
    <>
      <section className="space-y-3 pb-6">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <SearchIcon className="size-3" /> Search
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Search the dataset</h1>
        <p className="text-muted-foreground max-w-2xl">
          Type a company name, SOC code, occupation title, US state, or NAICS
          sector. Matches across the curated launch slice.
        </p>
      </section>

      <Card>
        <CardContent className="p-4">
          <form method="get" action="/search" className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="e.g. Cognizant, 15-1252, California, software developer"
                autoFocus
                required
                minLength={2}
                className="h-10 pl-9"
              />
            </div>
            <Button type="submit" size="lg">Search</Button>
          </form>
        </CardContent>
      </Card>

      {q.length === 0 ? (
        <p className="text-sm text-muted-foreground pt-6">
          Tip: every page on this site is reachable from a search term.
        </p>
      ) : q.length < 2 ? (
        <p className="text-sm text-muted-foreground pt-6">
          Keep typing — two characters minimum.
        </p>
      ) : results.length === 0 ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>No matches for &ldquo;{q}&rdquo;</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            The launch slice covers ~150 entities. If you searched for a small
            employer or rare SOC code, it&rsquo;s likely outside the current
            top-N cap — try a related term or browse{' '}
            <Link href="/employer" className="text-primary hover:underline">all employers</Link>.
          </CardContent>
        </Card>
      ) : (
        <SearchResults query={q} results={results} />
      )}
    </>
  );
}

function SearchResults({ query, results }: { query: string; results: SearchHit[] }) {
  const byKind = group(results);
  const order: SearchHit['kind'][] = ['employer', 'occupation', 'state', 'sector'];
  return (
    <section className="space-y-4 pt-6">
      <p className="text-sm text-muted-foreground">
        {results.length} result{results.length === 1 ? '' : 's'} for{' '}
        <strong className="text-foreground">&ldquo;{query}&rdquo;</strong>.
      </p>
      {order.map((kind) => {
        const hits = byKind.get(kind);
        if (!hits || hits.length === 0) return null;
        return (
          <Card key={kind}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                {titleFor(kind)}
                <Badge variant="outline" className="rounded-full text-xs">{hits.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="divide-y">
                {hits.map((h) => (
                  <li key={`${h.kind}-${h.slug}`} className="py-2.5">
                    <Link href={`/${h.kind}/${h.slug}`} className="font-medium hover:text-primary">
                      {h.primary}
                    </Link>
                    {(h.secondary || h.filings != null) ? (
                      <span className="text-sm text-muted-foreground">
                        {h.secondary ? <> · {h.secondary}</> : null}
                        {h.filings != null ? <> · {fmt(h.filings)} filings</> : null}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}

function group(results: SearchHit[]): Map<SearchHit['kind'], SearchHit[]> {
  const m = new Map<SearchHit['kind'], SearchHit[]>();
  for (const r of results) {
    const arr = m.get(r.kind) ?? [];
    arr.push(r);
    m.set(r.kind, arr);
  }
  return m;
}

function titleFor(kind: SearchHit['kind']): string {
  switch (kind) {
    case 'employer':   return 'Sponsors';
    case 'occupation': return 'Occupations';
    case 'state':      return 'States';
    case 'sector':     return 'Sectors';
  }
}
