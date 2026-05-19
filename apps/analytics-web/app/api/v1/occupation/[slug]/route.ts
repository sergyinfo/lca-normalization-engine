import { withAuth, corsPreflight } from '@/lib/api/auth';
import { ok, notFound } from '@/lib/api/responses';
import { occupationDetailShape } from '@/lib/api/serialize';
import {
  getOccupationBySlug, getOccupationLevels, getOccupationTopStates,
  getOccupationTopEmployers, getOccupationYearly,
} from '@/lib/queries';

export const OPTIONS = () => corsPreflight();

export const GET = withAuth(async (_req, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const o = getOccupationBySlug(slug);
  if (!o) return notFound(`Unknown occupation slug: ${slug}`);
  return ok(occupationDetailShape(
    o,
    getOccupationLevels(o.soc_code),
    getOccupationTopStates(o.soc_code),
    getOccupationTopEmployers(o.soc_code),
    getOccupationYearly(o.soc_code),
  ));
});
