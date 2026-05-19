/**
 * AdSlot — real AdSense `<ins>` when env is configured, dashed dev
 * placeholder otherwise.
 */

import type { ReactNode } from 'react';
import { ADSENSE_CLIENT_ID, getAdSenseSlotId } from '@/lib/adsense';

interface Props {
  name: string;
  height?: number;
  children?: ReactNode;
}

export function AdSlot({ name, height = 90, children }: Props) {
  const slotId = ADSENSE_CLIENT_ID ? getAdSenseSlotId(name) : null;

  if (!ADSENSE_CLIENT_ID || !slotId) {
    return (
      <div
        data-ad-slot={name}
        style={{ minHeight: height }}
        aria-label="Advertisement"
        className="my-6 flex items-center justify-center rounded-md border border-dashed border-border bg-muted/40 px-6 py-6 text-xs text-muted-foreground"
      >
        {children ?? `Ad slot · ${name}`}
      </div>
    );
  }

  return (
    <>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', minHeight: height }}
        data-ad-client={ADSENSE_CLIENT_ID}
        data-ad-slot={slotId}
        data-ad-format="auto"
        data-full-width-responsive="true"
        aria-label="Advertisement"
      />
      <script
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: '(adsbygoogle = window.adsbygoogle || []).push({});',
        }}
      />
    </>
  );
}
