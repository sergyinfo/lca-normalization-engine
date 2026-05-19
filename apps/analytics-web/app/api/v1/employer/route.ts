import { withAuth, corsPreflight } from '@/lib/api/auth';
import { ok } from '@/lib/api/responses';
import { employerSummaryShape } from '@/lib/api/serialize';
import { listTopEmployers } from '@/lib/queries';

export const OPTIONS = () => corsPreflight();

export const GET = withAuth(async (req) => {
  const u = new URL(req.url);
  const limit = clamp(Number(u.searchParams.get('limit') ?? 50), 1, 200);
  const page  = Math.max(1, Number(u.searchParams.get('page') ?? 1));
  // Pagination is fine on a small launch slice — we read all and slice.
  // Switch to LIMIT/OFFSET in the SQL when N grows.
  const all = listTopEmployers(500);
  const slice = all.slice((page - 1) * limit, page * limit);
  return ok(
    slice.map(employerSummaryShape),
    { page, limit, total: all.length },
  );
});

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
