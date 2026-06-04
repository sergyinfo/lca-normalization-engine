import { getQueueCounts } from '../lib/queries.js';

export default async function dashboardRoutes(app) {
  app.get('/', async (req, reply) => {
    const counts = await getQueueCounts();
    return reply.view('dashboard.ejs', {
      counts,
      flash: req.query.flash || null,
      // Release controls only render on the burst review box (INSTANCE_ID set).
      release: process.env.INSTANCE_ID ? (process.env.RELEASE || 'current') : null,
    });
  });
}
