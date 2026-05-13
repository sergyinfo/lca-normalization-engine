import {
  topSponsors,
  filingsByState,
  filingsByYear,
  topSocs,
} from '../lib/queries.js';

export default async function journalistRoutes(app) {
  app.get('/journalist', async (req, reply) => {
    const [sponsors, byState, byYear, socs] = await Promise.all([
      topSponsors({ limit: 20 }),
      filingsByState(),
      filingsByYear(),
      topSocs({ limit: 12 }),
    ]);
    return reply.view('journalist.ejs', {
      title: 'Journalist View',
      active: 'journalist',
      sponsors,
      byState,
      byYear,
      socs,
    });
  });
}
