/**
 * EntityHero — H1 + subtitle + KPI strip at the top of every entity page.
 *
 * Pre-formatted values come in via props (numbers already string-formatted
 * by the page). The component owns layout, type, and the accent treatment
 * on the "primary" KPI (typically Filings).
 */

import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface KpiTile {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** When true, renders with a blue-accent treatment. Use for the "headline" KPI. */
  accent?: boolean;
}

interface Props {
  eyebrow?: string;
  /** Optional small chips that sit beside the eyebrow (e.g. state code, rank). */
  chips?: Array<{ label: string; variant?: 'default' | 'secondary' | 'outline' }>;
  title: string;
  subtitle?: ReactNode;
  kpis?: KpiTile[];
}

export function EntityHero({ eyebrow, chips, title, subtitle, kpis }: Props) {
  return (
    <section className="space-y-5 pb-8">
      {(eyebrow || chips?.length) ? (
        <div className="flex flex-wrap items-center gap-2">
          {eyebrow ? (
            <Badge variant="secondary" className="rounded-full uppercase tracking-wider text-[10px] font-semibold">
              {eyebrow}
            </Badge>
          ) : null}
          {chips?.map((c, i) => (
            <Badge key={i} variant={c.variant ?? 'outline'} className="rounded-full">{c.label}</Badge>
          ))}
        </div>
      ) : null}

      <h1 className="text-3xl md:text-4xl font-bold tracking-tight leading-tight max-w-4xl">
        {title}
      </h1>

      {subtitle ? (
        <p className="text-muted-foreground text-base max-w-3xl leading-relaxed">{subtitle}</p>
      ) : null}

      {kpis && kpis.length > 0 ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
          {kpis.map((k, i) => (
            <Card key={i} className={k.accent ? 'border-primary/30 bg-secondary/40' : undefined}>
              <CardContent className="p-4 space-y-1">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {k.label}
                </div>
                <div className={`text-2xl font-bold tabular-nums leading-none ${k.accent ? 'text-primary' : ''}`}>
                  {k.value}
                </div>
                {k.sub ? <div className="text-xs text-muted-foreground pt-1">{k.sub}</div> : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </section>
  );
}
