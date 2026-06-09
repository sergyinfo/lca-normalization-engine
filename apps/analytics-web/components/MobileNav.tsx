'use client';

/**
 * Mobile nav: a hamburger button (shown only < md) that toggles a full-width
 * dropdown of the site nav links. The desktop nav is `hidden md:flex` in the
 * header, so without this there's no way to reach /state, /occupation, etc. on
 * a phone. The panel positions itself below the sticky header (top-full) and
 * closes on link tap.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';

export function MobileNav({ links }: { links: ReadonlyArray<{ href: string; label: string }> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="md:hidden inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>

      {open ? (
        <div className="md:hidden absolute left-0 right-0 top-full border-b bg-background shadow-lg">
          <nav className="mx-auto flex max-w-6xl flex-col px-4 py-2">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}
    </>
  );
}
