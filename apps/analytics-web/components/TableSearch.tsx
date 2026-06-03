'use client';

/**
 * Shared filter input for the entity-explorer tables. Rendered at both the top
 * (in the card header) and bottom of a table, bound to the same state, so the
 * filter is reachable from either end of a long list.
 */
import { Search } from 'lucide-react';

export interface TableSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}

export function TableSearch({ value, onChange, placeholder, ariaLabel }: TableSearchProps) {
  return (
    <label className="relative w-full sm:w-72">
      <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background h-9 pl-8 pr-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={ariaLabel}
      />
    </label>
  );
}
