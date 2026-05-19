import {
  topGrowthSponsors,
  shrinkingSponsors,
  topSponsorsInTech,
  naicsSectorSummary,
} from '../lib/queries.js';

export default async function investorRoutes(app) {
  app.get('/investor', async (req, reply) => {
    const [growing, shrinking, tech, sectors] = await Promise.all([
      topGrowthSponsors({ limit: 20 }),
      shrinkingSponsors({ limit: 20 }),
      topSponsorsInTech({ limit: 20 }),
      naicsSectorSummary(),
    ]);
    return reply.view('investor.ejs', {
      title: 'Investor / BI',
      active: 'investor',
      growing,
      shrinking,
      tech,
      sectors,
    });
  });
}
