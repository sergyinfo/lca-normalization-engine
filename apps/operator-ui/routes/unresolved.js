import {
  listUnresolved,
  getUnresolved,
  findSimilarCanonicals,
  mergeUnresolved,
  createCanonicalAndMerge,
  rejectUnresolved,
} from '../lib/queries.js';

export default async function unresolvedRoutes(app) {
  app.get('/unresolved', async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = await listUnresolved({ limit, offset });
    return reply.view('unresolved/list.ejs', {
      rows,
      limit,
      offset,
      flash: req.query.flash || null,
    });
  });

  app.get('/unresolved/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const record = await getUnresolved(id);
    if (!record) {
      return reply.code(404).view('error.ejs', { message: 'Unresolved record not found' });
    }
    const candidates = await findSimilarCanonicals({
      name: record.employer_name,
      state: record.employer_state,
      limit: 20,
    });
    return reply.view('unresolved/inspect.ejs', {
      record,
      candidates,
      flash: req.query.flash || null,
    });
  });

  app.post('/unresolved/:id/merge', async (req, reply) => {
    const id = Number(req.params.id);
    const canonicalId = (req.body?.canonical_id ?? '').toString().trim();
    if (!canonicalId) {
      return reply.redirect(`/unresolved/${id}?flash=missing_canonical`);
    }
    const result = await mergeUnresolved({ unresolvedId: id, canonicalId });
    if (result.error === 'canonical_not_found') {
      return reply.redirect(`/unresolved/${id}?flash=canonical_not_found`);
    }
    return reply.redirect(`/unresolved?flash=merged_${result.backfilled}`);
  });

  app.post('/unresolved/:id/create', async (req, reply) => {
    const id = Number(req.params.id);
    const canonicalName = (req.body?.canonical_name ?? '').toString().trim() || null;
    const result = await createCanonicalAndMerge({ unresolvedId: id, canonicalName });
    return reply.redirect(`/unresolved?flash=created_${result.backfilled}`);
  });

  app.post('/unresolved/:id/reject', async (req, reply) => {
    const id = Number(req.params.id);
    const note = (req.body?.note ?? '').toString().trim() || null;
    await rejectUnresolved({ id, note });
    return reply.redirect('/unresolved?flash=rejected');
  });
}
