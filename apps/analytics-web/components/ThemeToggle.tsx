'use client';

/**
 * Two-state theme toggle: Light ↔ Dark.
 *
 * Driven by `resolvedTheme` (the *rendered* theme, accounting for system
 * preference) rather than `theme` (the *chosen* preference), so every click
 * is guaranteed to flip what the user sees. The result is still persisted
 * by next-themes under the localStorage 'theme' key.
 */

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — render a stable icon until mounted, then
  // swap in the real resolved state.
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';
  const Icon = isDark ? Sun : Moon;
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={label}
      title={label}
      className="inline-flex size-9 cursor-pointer items-center justify-center rounded-md
                 text-muted-foreground hover:bg-muted hover:text-foreground
                 transition-colors"
    >
      <Icon className="size-4" />
    </button>
  );
}
