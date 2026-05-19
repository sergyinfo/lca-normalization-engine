import {
  caseStatusByYear,
  sponsorRiskLeaderboard,
  cleanestSponsors,
  caseStatusBreakdown,
} from '../lib/queries.js';

export default async function attorneyRoutes(app) {
  app.get('/attorney', async (req, reply) => {
    const sort = req.query.sort === 'withdrawn' ? 'withdrawn'
              : req.query.sort === 'cert_withdrawn' ? 'cert_withdrawn'
              : 'denied';
    const [trend, risky, clean, overall] = await Promise.all([
      caseStatusByYear(),
      sponsorRiskLeaderboard({ sort, limit: 20 }),
      cleanestSponsors({ limit: 20 }),
      caseStatusBreakdown(),
    ]);
    return reply.view('attorney.ejs', {
      title: 'Immigration Attorney',
      active: 'attorney',
      trend,
      risky,
      clean,
      overall,
      sort,
    });
  });
}
