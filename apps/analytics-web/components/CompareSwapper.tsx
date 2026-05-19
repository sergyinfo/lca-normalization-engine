'use client';

/**
 * Two-column swap picker for use ON a compare page. Lets the visitor
 * swap either entity A or entity B without going back to the entity page.
 *
 * Picking on the left column → navigate to /compare/{kind}/{picked}/{B}
 * Picking on the right column → navigate to /compare/{kind}/{A}/{picked}
 *
 * Future-proofing: when we extend to 3-4 entities, this same component
 * can grow to N columns by accepting an array of slots.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { GitCompare, Search } from 'lucide-react';

import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import type { PeerOption } from './ComparePicker';

type Kind = 'employer' | 'occupation' | 'state' | 'sector';

interface Props {
  kind: Kind;
  /** Currently-selected left and right entities. */
  current: { left: { slug: string; label: string }; right: { slug: string; label: string } };
  /** All other entities of this kind (already excludes the two current ones). */
  peers: PeerOption[];
}

const KIND_VERB: Record<Kind, string> = {
  employer:   'sponsor',
  occupation: 'occupation',
  state:      'state',
  sector:     'sector',
};

export function CompareSwapper({ kind, current, peers }: Props) {
  return (
    <Card className="bg-gradient-to-br from-primary/5 to-violet-500/5 border-primary/20">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-md bg-background flex items-center justify-center text-primary shrink-0">
            <GitCompare className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold">Swap an entity</div>
            <div className="text-sm text-muted-foreground">
              Replace either {KIND_VERB[kind]} above without losing the
              comparison. 2-way for now; 3+ comparison coming soon.
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <SwapColumn
            heading={`Swap A: ${current.left.label}`}
            kind={kind}
            peers={peers}
            buildHref={(peerSlug) => `/compare/${kind}/${peerSlug}/${current.right.slug}`}
            accent="primary"
          />
          <SwapColumn
            heading={`Swap B: ${current.right.label}`}
            kind={kind}
            peers={peers}
            buildHref={(peerSlug) => `/compare/${kind}/${current.left.slug}/${peerSlug}`}
            accent="violet"
          />
        </div>
      </CardContent>
    </Card>
  );
}

/* ---- column ----------------------------------------------------------- */

function SwapColumn({
  heading, kind, peers, buildHref, accent,
}: {
  heading: string;
  kind: Kind;
  peers: PeerOption[];
  buildHref: (peerSlug: string) => string;
  accent: 'primary' | 'violet';
}) {
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
      .slice(0, 6);
  }, [q, peers]);
  const suggested = peers.slice(0, 4);
  const chipBorderHover = accent === 'primary'
    ? 'hover:border-primary/40 hover:bg-primary/5'
    : 'hover:border-violet-400/40 hover:bg-violet-500/5';
  return (
    <div className="rounded-md border bg-background p-3 space-y-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground truncate" title={heading}>
        {heading}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${KIND_VERB[kind]}s…`}
          className="pl-9 h-9 text-sm"
        />
      </div>
      {q.trim().length > 0 ? (
        filtered.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {filtered.map((p) => (
              <li key={p.slug}>
                <Link
                  href={buildHref(p.slug)}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-secondary/50 transition-colors"
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
          <p className="text-sm text-muted-foreground px-1">No matches.</p>
        )
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {suggested.map((p) => (
            <Link
              key={p.slug}
              href={buildHref(p.slug)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${chipBorderHover}`}
            >
              <span className="truncate max-w-[160px] font-medium">{p.label}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
