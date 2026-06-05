'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { AdFormat } from '@/lib/ad-slots';

/**
 * AdPlaceholder — a visible "where an ad goes" marker for slots that don't have an
 * AdSense id yet. Shown on every host EXCEPT the canonical production domain (taken
 * from NEXT_PUBLIC_SITE_URL).
 *
 * Why a runtime host check instead of a build flag: dev and prod serve the SAME
 * image (promote just retags :latest→:prod), so a build-time env can't tell them
 * apart. We decide at runtime by hostname — visible on dev.h1b.report / localhost /
 * preview hosts, hidden on h1b.report. Renders nothing until mounted to avoid a
 * hydration mismatch, so prod never flashes an empty "Advertisement" card.
 */
export function AdPlaceholder({
  name,
  format,
  minHeight,
  className,
}: {
  name: string;
  format: AdFormat;
  minHeight: number;
  className?: string;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      const prod = new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://h1b.report')
        .hostname.replace(/^www\./, '');
      const host = window.location.hostname.replace(/^www\./, '');
      setShow(host !== prod); // hidden only on the canonical prod host
    } catch {
      setShow(false);
    }
  }, []);

  if (!show) return null;

  return (
    <aside
      aria-label="Advertisement placeholder"
      className={cn(
        'my-8 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm',
        format === 'rectangle' && 'mx-auto max-w-[360px]',
        className,
      )}
    >
      <div className="flex items-center justify-center p-3">
        <div
          style={{ minHeight }}
          className="flex w-full items-center justify-center rounded border border-dashed border-border bg-muted/30 px-6 text-center text-xs text-muted-foreground"
        >
          Ad slot · {name} · {format}
        </div>
      </div>
    </aside>
  );
}
