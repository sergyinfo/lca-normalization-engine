'use client';

import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from 'next-themes';

/**
 * Thin client wrapper around next-themes that lives in the layout. Picks up
 * the user's prior choice from localStorage on hydration and injects an
 * inline <script> in <head> to set the class before first paint — so there's
 * no flash of light theme on dark-mode users.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
