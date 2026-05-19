import { withAuth, corsPreflight } from '@/lib/api/auth';
import { ok } from '@/lib/api/responses';
import { sectorSummaryShape } from '@/lib/api/serialize';
import { listTopSectors } from '@/lib/queries';

export const OPTIONS = () => corsPreflight();

export const GET = withAuth(async () => {
  return ok(listTopSectors(60).map(sectorSummaryShape));
});
