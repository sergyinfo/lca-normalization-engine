import { withAuth, corsPreflight } from '@/lib/api/auth';
import { ok } from '@/lib/api/responses';
import { occupationSummaryShape } from '@/lib/api/serialize';
import { listTopOccupations } from '@/lib/queries';

export const OPTIONS = () => corsPreflight();

export const GET = withAuth(async (req) => {
  const u = new URL(req.url);
  const limit = clamp(Number(u.searchParams.get('limit') ?? 50), 1, 200);
  const page  = Math.max(1, Number(u.searchParams.get('page') ?? 1));
  const all = listTopOccupations(500);
  const slice = all.slice((page - 1) * limit, page * limit);
  return ok(
    slice.map(occupationSummaryShape),
    { page, limit, total: all.length },
  );
});

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
