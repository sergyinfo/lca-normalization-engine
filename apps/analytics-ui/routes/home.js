import { getOverviewKpis } from '../lib/queries.js';

export default async function homeRoutes(app) {
  app.get('/', async (req, reply) => {
    const kpis = await getOverviewKpis();
    return reply.view('home.ejs', {
      title: 'LCA Analytics',
      kpis,
    });
  });
}
