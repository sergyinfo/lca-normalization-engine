/**
 * AdSlot — a natively-styled ad placement.
 *
 * - Renders a real AdSense unit when its id is configured (ad-slots registry or
 *   ADSENSE_SLOTS env).
 * - In development, renders a labeled placeholder so slots are visible while building.
 * - In production with no id yet, renders nothing (clean site for users + AdSense
 *   review) — no empty gap until you wire the slot.
 *
 * Size + ad-format come from the registry (`lib/ad-slots.ts`) by `name`, so a
 * placement is just `<AdSlot name="employer-top" />`.
 */

import type { ReactNode } from 'react';
import { ADSENSE_CLIENT_ID, getAdSenseSlotId } from '@/lib/adsense';
import { getSlotDef, type AdFormat } from '@/lib/ad-slots';
import { cn } from '@/lib/utils';
import { AdPlaceholder } from './AdPlaceholder';

interface Props {
  name: string;
  className?: string;
}

const MIN_HEIGHT: Record<AdFormat, number> = {
  horizontal: 100,
  'in-article': 160,
  rectangle: 280,
};

/** Site-native card wrapper with a small "Advertisement" eyebrow. */
function AdFrame({ format, className, children }: { format: AdFormat; className?: string; children: ReactNode }) {
  return (
    <aside
      aria-label="Advertisement"
      className={cn(
        'my-8 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm',
        format === 'rectangle' && 'mx-auto max-w-[360px]',
        className,
      )}
    >
      <div className="border-b bg-muted/30 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Advertisement
      </div>
      <div className="flex items-center justify-center p-3">{children}</div>
    </aside>
  );
}

export function AdSlot({ name, className }: Props) {
  const { format } = getSlotDef(name);
  const minHeight = MIN_HEIGHT[format];
  const slotId = ADSENSE_CLIENT_ID ? getAdSenseSlotId(name) : null;

  // Real ad unit.
  if (ADSENSE_CLIENT_ID && slotId) {
    const fluid = format === 'in-article';
    return (
      <AdFrame format={format} className={className}>
        <ins
          className="adsbygoogle"
          style={{ display: 'block', width: '100%', minHeight }}
          data-ad-client={ADSENSE_CLIENT_ID}
          data-ad-slot={slotId}
          data-ad-format={fluid ? 'fluid' : 'auto'}
          data-ad-layout={fluid ? 'in-article' : undefined}
          data-full-width-responsive={fluid ? undefined : 'true'}
        />
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: '(adsbygoogle = window.adsbygoogle || []).push({});' }}
        />
      </AdFrame>
    );
  }

  // No id yet: a host-gated placeholder (visible on dev/localhost/preview hosts,
  // hidden on the canonical prod domain) so you can see where each slot lands.
  return <AdPlaceholder name={name} format={format} minHeight={minHeight} className={className} />;
}
