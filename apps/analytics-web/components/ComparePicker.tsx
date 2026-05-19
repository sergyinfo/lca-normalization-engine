'use client';

/**
 * Compare picker — entity page bottom CTA.
 *
 * Server passes in the full peer list (top N other entities of the same
 * kind, excluding self). Client filters by typed query + shows top
 * suggestions as a chip rail for one-click compare.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { GitCompare, Search } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export interface PeerOption {
  slug: string;
  label: string;
  /** Optional second-line hint (state, SOC code, etc.). */
  hint?: string;
}

interface Props {
  /** This entity's kind — drives the compare route prefix. */
  kind: 'employer' | 'occupation' | 'state' | 'sector';
  /** This entity's slug, used to build /compare/{kind}/{self}/{other}. */
  selfSlug: string;
  /** Display name for the "you are comparing with" header. */
  selfLabel: string;
  /** All other entities of this kind (already filtered to exclude self). */
  peers: PeerOption[];
  /** Top N peers shown as quick-pick chips. Default 6. */
  suggestedCount?: number;
}

const KIND_VERB: Record<Props['kind'], string> = {
  employer:   'sponsor',
  occupation: 'occupation',
  state:      'state',
  sector:     'sector',
};

export function ComparePicker({
  kind, selfSlug, selfLabel, peers, suggestedCount = 6,
}: Props) {
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return peers
      .filter((p) =>
        p.label.toLowerCase().includes(needle) ||
        (p.hint?.toLowerCase().includes(needle) ?? false) ||
        p.slug.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [q, peers]);

  const suggested = peers.slice(0, suggestedCount);

  return (
    <Card className="bg-gradient-to-br from-primary/5 to-violet-500/5 border-primary/20">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-md bg-background flex items-center justify-center text-primary shrink-0">
            <GitCompare className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold">Compare {selfLabel} with another {KIND_VERB[kind]}</div>
            <div className="text-sm text-muted-foreground">
              Side-by-side view of KPIs, outcomes, top breakdowns and yearly trend.
            </div>
          </div>
        </div>

        {/* Search input */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${KIND_VERB[kind]}s…`}
            className="pl-9 bg-background"
          />
        </div>

        {/* Search results (when typing) */}
        {q.trim().length > 0 ? (
          filtered.length > 0 ? (
            <ul className="rounded-md border bg-background divide-y">
              {filtered.map((p) => (
                <li key={p.slug}>
                  <Link
                    href={`/compare/${kind}/${selfSlug}/${p.slug}`}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-secondary/50 transition-colors"
                  >
                    <span className="truncate font-medium">{p.label}</span>
                    {p.hint ? (
                      <span className="text-xs text-muted-foreground shrink-0">{p.hint}</span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground px-1">
              No matches for &ldquo;{q}&rdquo;.
            </p>
          )
        ) : (
          // Suggested peers chip rail
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
              Popular comparisons
            </div>
            <div className="flex flex-wrap gap-2">
              {suggested.map((p) => (
                <Link
                  key={p.slug}
                  href={`/compare/${kind}/${selfSlug}/${p.slug}`}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-xs
                             hover:border-primary/40 hover:bg-primary/5 transition-colors"
                >
                  <GitCompare className="size-3 text-primary" />
                  <span className="font-medium truncate max-w-[200px]">{p.label}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
