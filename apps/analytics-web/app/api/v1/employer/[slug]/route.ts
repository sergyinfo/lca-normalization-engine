import { withAuth, corsPreflight } from '@/lib/api/auth';
import { ok, notFound } from '@/lib/api/responses';
import { employerDetailShape } from '@/lib/api/serialize';
import { getEmployer, getEmployerTopSocs, getEmployerYearly } from '@/lib/queries';

export const OPTIONS = () => corsPreflight();

export const GET = withAuth(async (_req, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const e = getEmployer(slug);
  if (!e) return notFound(`Unknown employer slug: ${slug}`);
  return ok(employerDetailShape(e, getEmployerTopSocs(slug), getEmployerYearly(slug)));
});
