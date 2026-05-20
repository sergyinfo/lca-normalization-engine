import Link from 'next/link';
import { Archive, ArrowRight } from 'lucide-react';

/**
 * Banner shown on every /archive/... page. Tells the user (and any crawler
 * that follows it) that this is a frozen snapshot, with a one-click link to
 * the live equivalent.
 *
 * Pair with `<meta name="robots" content="noindex, follow">` in the page
 * metadata so search engines don't compete this URL with the live one.
 */
interface Props {
  /** "2026-q1" → displayed as "2026 Q1" */
  label: string;
  /** Path on the live site that equates to this archived view, if any. */
  livePath?: string;
}

export function ArchiveBanner({ label, livePath }: Props) {
  const display = label.replace(/^(\d{4})-q(\d)$/, '$1 Q$2');
  return (
    <div className="mb-6 rounded-lg border border-amber-300/40 bg-amber-50/60 dark:bg-amber-950/30 dark:border-amber-800/40 px-4 py-3">
      <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4 text-sm">
        <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200 font-medium">
          <Archive className="size-4" />
          Archived snapshot · {display}
        </div>
        <div className="text-amber-900/80 dark:text-amber-200/80 flex-1">
          You are viewing a frozen snapshot. Data has been refreshed since
          this was captured.
        </div>
        {livePath ? (
          <Link
            href={livePath}
            className="inline-flex items-center gap-1 text-amber-900 dark:text-amber-200 font-semibold hover:underline whitespace-nowrap"
          >
            See current data <ArrowRight className="size-3" />
          </Link>
        ) : (
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-amber-900 dark:text-amber-200 font-semibold hover:underline whitespace-nowrap"
          >
            Go to live site <ArrowRight className="size-3" />
          </Link>
        )}
      </div>
    </div>
  );
}
