import { withAuth, corsPreflight } from '@/lib/api/auth';
import { ok } from '@/lib/api/responses';
import { kpisShape } from '@/lib/api/serialize';
import { getSiteKpis } from '@/lib/queries';

export const OPTIONS = () => corsPreflight();

export const GET = withAuth(async () => {
  return ok(kpisShape(getSiteKpis()));
});
