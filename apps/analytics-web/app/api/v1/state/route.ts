import { withAuth, corsPreflight } from '@/lib/api/auth';
import { ok } from '@/lib/api/responses';
import { stateSummaryShape } from '@/lib/api/serialize';
import { listTopStates } from '@/lib/queries';

export const OPTIONS = () => corsPreflight();

export const GET = withAuth(async () => {
  // States are bounded (50+); single response, no pagination needed.
  return ok(listTopStates(60).map(stateSummaryShape));
});
