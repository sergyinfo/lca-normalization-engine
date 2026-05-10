import {
  listQuarantine,
  getQuarantineRecord,
  assignQuarantineSoc,
  dropQuarantine,
} from '../lib/queries.js';

export default async function quarantineRoutes(app) {
  app.get('/quarantine', async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = await listQuarantine({ limit, offset });
    return reply.view('quarantine/list.ejs', {
      rows,
      limit,
      offset,
      flash: req.query.flash || null,
    });
  });

  app.get('/quarantine/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const record = await getQuarantineRecord(id);
    if (!record) {
      return reply.code(404).view('error.ejs', { message: 'Quarantine record not found' });
    }
    return reply.view('quarantine/inspect.ejs', { record, flash: req.query.flash || null });
  });

  app.post('/quarantine/:id/assign', async (req, reply) => {
    const id = Number(req.params.id);
    const socCode = (req.body?.soc_code ?? '').toString().trim();
    const socTitle = (req.body?.soc_title ?? '').toString().trim() || null;
    const note = (req.body?.note ?? '').toString().trim() || null;
    if (!socCode) {
      return reply.redirect(`/quarantine/${id}?flash=missing_soc`);
    }
    const result = await assignQuarantineSoc({ id, socCode, socTitle, note });
    if (result.updated === 0) {
      return reply.redirect(`/quarantine/${id}?flash=not_found`);
    }
    const flash = result.lcaUpdated ? 'assigned' : 'assigned_orphan';
    return reply.redirect(`/quarantine?flash=${flash}`);
  });

  app.post('/quarantine/:id/drop', async (req, reply) => {
    const id = Number(req.params.id);
    const note = (req.body?.note ?? '').toString().trim() || null;
    await dropQuarantine({ id, note });
    return reply.redirect('/quarantine?flash=dropped');
  });
}
