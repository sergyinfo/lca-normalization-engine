import { getQueueCounts } from '../lib/queries.js';

export default async function dashboardRoutes(app) {
  app.get('/', async (req, reply) => {
    const counts = await getQueueCounts();
    return reply.view('dashboard.ejs', { counts });
  });
}
