/**
 * Summary — renders the LLM-generated per-page markdown from SQLite. Server
 * component. Card with a blue left-accent stripe so it's visually distinct
 * from the data tables.
 */

import { compileMDX } from 'next-mdx-remote/rsc';
import type { EntitySummaryRow } from '@/lib/queries';
import { Sparkles } from 'lucide-react';

interface Props {
  summary: EntitySummaryRow | null;
}

export async function Summary({ summary }: Props) {
  if (!summary) return null;
  const { content } = await compileMDX({ source: summary.summary_md });
  return (
    <aside
      aria-label="At-a-glance summary"
      className="relative my-6 rounded-lg border bg-secondary/30 p-5 pl-6"
    >
      <div className="absolute inset-y-0 left-0 w-1 rounded-l-lg bg-primary" />
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary mb-2">
        <Sparkles className="size-3.5" />
        Summary
      </div>
      <div className="text-sm text-foreground/85 leading-relaxed [&>p]:mb-2 [&>p:last-child]:mb-0 [&_strong]:font-semibold [&_code]:font-mono [&_code]:text-xs [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5">
        {content}
      </div>
    </aside>
  );
}
