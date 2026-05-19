import { withAuth, corsPreflight } from '@/lib/api/auth';
import { ok, notFound } from '@/lib/api/responses';
import { sectorSummaryShape } from '@/lib/api/serialize';
import { getSectorBySlug } from '@/lib/queries';

export const OPTIONS = () => corsPreflight();

export const GET = withAuth(async (_req, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const s = getSectorBySlug(slug);
  if (!s) return notFound(`Unknown sector slug: ${slug}`);
  return ok(sectorSummaryShape(s));
});
