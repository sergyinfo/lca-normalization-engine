import Link from 'next/link';
import type { ReactNode } from 'react';
import { Trophy } from 'lucide-react';

import { Card, CardContent } from './ui/card';

type Kind = 'employer' | 'occupation' | 'state' | 'sector';

interface RankingLink {
  href: string;
  label: string;
}

const LINKS: Record<Kind, RankingLink[]> = {
  employer: [
    { href: '/top-h1b-sponsors',     label: 'Top 100 sponsors' },
    { href: '/cleanest-h1b-sponsors',label: 'Cleanest sponsors' },
    { href: '/rankings',             label: 'All rankings' },
  ],
  occupation: [
    { href: '/top-h1b-occupations',     label: 'Top H-1B occupations' },
    { href: '/highest-paying-h1b-jobs', label: 'Highest-paying H-1B jobs' },
    { href: '/rankings',                label: 'All rankings' },
  ],
  state: [
    { href: '/top-h1b-states', label: 'Top H-1B states' },
    { href: '/rankings',       label: 'All rankings' },
  ],
  sector: [
    { href: '/h1b-by-industry', label: 'H-1B by industry' },
    { href: '/rankings',        label: 'All rankings' },
  ],
};

interface Props {
  kind: Kind;
  /** Extra slot for custom content, rendered after the chip rail. */
  children?: ReactNode;
}

export function SeeAlsoLinks({ kind, children }: Props) {
  const links = LINKS[kind];
  return (
    <Card className="bg-muted/20 border-muted-foreground/10">
      <CardContent className="p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-background flex items-center justify-center text-amber-600 shrink-0">
            <Trophy className="size-4" />
          </div>
          <div>
            <div className="font-semibold">Explore by rank</div>
            <div className="text-sm text-muted-foreground">
              Pre-built leaderboards for the most-asked questions.
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="inline-flex items-center rounded-full border bg-background px-3 py-1.5 text-xs font-medium
                         hover:border-primary/40 hover:bg-primary/5 transition-colors"
            >
              {l.label}
            </Link>
          ))}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}
