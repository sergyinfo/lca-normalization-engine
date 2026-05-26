'use client';

/**
 * Page minimap: a thin right-side rail showing every section on the page
 * as a height-proportional block, with a translucent rectangle marking
 * the currently-visible viewport. Click a block to scroll.
 *
 * Wire up:
 *   1. Render <PageMinimap /> once anywhere in the page tree.
 *   2. Tag every section wrapper with
 *        data-section-id="<unique>"
 *        data-section-label="<short name>"
 *   3. Optionally pass a `selector` prop if you want to scope the scan
 *      (default: `[data-section-id]`).
 *
 * Performance notes:
 *   - Geometry is recomputed on scroll (rAF-throttled) and on resize.
 *   - We don't observe DOM mutations — sections are assumed stable for
 *     the lifetime of the page. This matches our prerender-heavy pages.
 *   - Hidden on screens narrower than 1280px (lg breakpoint) to keep the
 *     reading column comfortable on smaller laptops.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Section {
  id: string;
  label: string;
  /** Position of the section's top within the document, in px. */
  top: number;
  /** Section height, in px. */
  height: number;
}

export interface PageMinimapProps {
  /** CSS selector for sections to include. */
  selector?: string;
  /** Only show the rail if there are at least this many sections. */
  minSections?: number;
}

// useLayoutEffect throws a warning on SSR; useEffect with same code is OK
// since our useLayoutEffect only does DOM measurements that need to happen
// before paint. Pick whichever is available.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function PageMinimap({
  selector = '[data-section-id]',
  minSections = 3,
}: PageMinimapProps) {
  const [sections, setSections] = useState<Section[]>([]);
  const [docHeight, setDocHeight] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const rafRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    if (typeof window === 'undefined') return;
    const els = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const scrollY = window.scrollY;
    const measured: Section[] = els.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        id: el.dataset.sectionId ?? el.id ?? '',
        label: el.dataset.sectionLabel ?? el.dataset.sectionId ?? '',
        top: rect.top + scrollY,
        height: rect.height,
      };
    }).filter((s) => s.id && s.height > 0);
    setSections(measured);
    setDocHeight(document.documentElement.scrollHeight);
    setViewport({ top: scrollY, height: window.innerHeight });
  }, [selector]);

  // Schedule a measure on the next animation frame (rAF-throttled).
  const scheduleMeasure = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      measure();
    });
  }, [measure]);

  useIsoLayoutEffect(() => {
    measure();
    window.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    // Re-measure once after fonts settle + late content renders.
    const t = window.setTimeout(measure, 300);
    return () => {
      window.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      window.clearTimeout(t);
    };
  }, [measure, scheduleMeasure]);

  if (sections.length < minSections || docHeight === 0) return null;

  const RAIL_HEIGHT = 320; // px — bounded so the rail fits in any viewport.
  const yFor = (px: number) => (px / docHeight) * RAIL_HEIGHT;

  // Active section: whichever block contains the viewport centre.
  const viewCentreDoc = viewport.top + viewport.height / 2;
  const activeId = sections.find(
    (s) => viewCentreDoc >= s.top && viewCentreDoc < s.top + s.height,
  )?.id;

  const scrollTo = (id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 16;
    window.scrollTo({ top, behavior: 'smooth' });
  };

  return (
    <aside
      aria-label="Page outline"
      // Flush to the left edge with a small inset; the pill itself is wider
      // (3.5 instead of 2.5) so colors read more clearly.
      className="hidden xl:block fixed left-2 top-1/2 -translate-y-1/2 z-30 select-none"
    >
      <div
        className="relative w-3.5 rounded-full bg-muted/40 border border-border/40 shadow-md backdrop-blur-sm"
        style={{ height: RAIL_HEIGHT }}
      >
        {sections.map((s, i) => {
          const blockTop = yFor(s.top);
          const blockH = Math.max(5, yFor(s.height));
          const isActive = s.id === activeId;
          // Stable per-section colour from a small curated palette.
          // Index-based so the same section keeps the same colour on every
          // re-render and looks the same across page reloads.
          const palette = SECTION_PALETTE[i % SECTION_PALETTE.length]!;
          return (
            // Wrapper carries the layout + `group` hover scope. The button
            // (scaled on hover) and the label (NOT scaled) live as siblings,
            // so the label can't inherit the button's transform and stay
            // perfectly crisp.
            <div
              key={s.id}
              className="group absolute left-0 right-0"
              style={{
                top: blockTop,
                height: blockH,
                marginTop: i === 0 ? 0 : 1,
              }}
            >
              <button
                type="button"
                onClick={() => scrollTo(s.id)}
                aria-label={`Jump to ${s.label}`}
                aria-current={isActive ? 'true' : undefined}
                className="absolute inset-0 rounded-sm cursor-pointer transition-[opacity,transform,box-shadow] duration-300 ease-out group-hover:scale-x-[1.4] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                style={{
                  backgroundColor: palette,
                  opacity: isActive ? 1 : 0.55,
                  boxShadow: isActive ? `0 0 0 1.5px ${palette}, 0 0 12px ${palette}55` : undefined,
                  // Anchor scale on the LEFT so blocks grow toward the
                  // content (which sits to the right of the rail).
                  transformOrigin: 'left center',
                }}
              />
              {/* Floating label — sibling of the button so it doesn't
                  inherit the scale-x transform and stay crisp. */}
              <span
                className={`pointer-events-none absolute left-full ml-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md transition-opacity duration-200 ${
                  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                style={{
                  borderColor: isActive ? `${palette}66` : undefined,
                }}
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-1.5 rounded-full mr-1.5 align-middle"
                  style={{ backgroundColor: palette }}
                />
                {s.label}
              </span>
            </div>
          );
        })}

        {/* Viewport overlay — translucent rectangle that follows scroll.
            Slightly longer transition for a smoother glide; cubic-bezier
            keeps the motion responsive without feeling sluggish. */}
        <div
          aria-hidden="true"
          className="absolute left-[-4px] right-[-4px] rounded-md border-2 border-primary/70 bg-primary/10 pointer-events-none"
          style={{
            top: yFor(viewport.top),
            height: Math.max(8, yFor(viewport.height)),
            transition: 'top 220ms cubic-bezier(0.22, 1, 0.36, 1), height 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
      </div>
    </aside>
  );
}

// Curated palette — each block on the rail gets a stable hue based on its
// position. Chosen for legibility on both light and dark backgrounds
// (saturation around 60-70%, brightness around 50-60%). 8 entries cycles
// past the longest section list we ship today (8 sections on /sector and
// /occupation detail pages).
const SECTION_PALETTE = [
  'hsl(217 91% 60%)', // blue   — primary
  'hsl(160 84% 45%)', // teal
  'hsl(38  92% 55%)', // amber
  'hsl(262 83% 65%)', // violet
  'hsl(190 95% 50%)', // cyan
  'hsl(330 81% 60%)', // pink
  'hsl(95  60% 50%)', // lime
  'hsl(15  90% 60%)', // coral
] as const;
