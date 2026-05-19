import { withAuth, corsPreflight } from '@/lib/api/auth';
import { ok, notFound } from '@/lib/api/responses';
import { stateDetailShape } from '@/lib/api/serialize';
import { getStateBySlug, getStateTopEmployers, getStateTopOccupations } from '@/lib/queries';

export const OPTIONS = () => corsPreflight();

export const GET = withAuth(async (_req, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const s = getStateBySlug(slug);
  if (!s) return notFound(`Unknown state slug: ${slug}`);
  return ok(stateDetailShape(
    s,
    getStateTopEmployers(s.code),
    getStateTopOccupations(s.code),
  ));
});
