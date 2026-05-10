import {
  listReviews,
  getReview,
  patchReview,
  rejectReviewToQuarantine,
} from '../lib/queries.js';

export default async function reviewRoutes(app) {
  app.get('/reviews', async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const reason = req.query.reason || null;
    const rows = await listReviews({ limit, offset, reason });
    return reply.view('reviews/list.ejs', {
      rows,
      limit,
      offset,
      reason,
      flash: req.query.flash || null,
    });
  });

  app.get('/reviews/:filingYear/:id', async (req, reply) => {
    const filingYear = Number(req.params.filingYear);
    const id = Number(req.params.id);
    const record = await getReview({ filingYear, id });
    if (!record) {
      return reply.code(404).view('error.ejs', { message: 'Review record not found' });
    }
    return reply.view('reviews/inspect.ejs', { record, flash: req.query.flash || null });
  });

  app.post('/reviews/:filingYear/:id/accept', async (req, reply) => {
    const filingYear = Number(req.params.filingYear);
    const id = Number(req.params.id);
    await patchReview({
      filingYear,
      id,
      patch: { operator_action: 'accepted' },
    });
    return reply.redirect('/reviews?flash=accepted');
  });

  app.post('/reviews/:filingYear/:id/override', async (req, reply) => {
    const filingYear = Number(req.params.filingYear);
    const id = Number(req.params.id);
    const socCode = (req.body?.soc_code ?? '').toString().trim();
    const socTitle = (req.body?.soc_title ?? '').toString().trim() || null;
    if (!socCode) {
      return reply.redirect(`/reviews/${filingYear}/${id}?flash=missing_soc`);
    }
    await patchReview({
      filingYear,
      id,
      patch: {
        soc_code: socCode,
        soc_title: socTitle,
        soc_confidence: 1.0,
        soc_source: 'operator',
        operator_action: 'overridden',
      },
    });
    return reply.redirect('/reviews?flash=overridden');
  });

  app.post('/reviews/:filingYear/:id/reject', async (req, reply) => {
    const filingYear = Number(req.params.filingYear);
    const id = Number(req.params.id);
    const reason = (req.body?.reason ?? '').toString().trim() || null;
    await rejectReviewToQuarantine({ filingYear, id, reason });
    return reply.redirect('/reviews?flash=rejected');
  });
}
