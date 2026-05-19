import {
  naicsSectorSummary,
  naicsSectorByYear,
  socShareByYear,
  medianWageByYear,
  wageGrowthTopOccupations,
} from '../lib/queries.js';

export default async function economistRoutes(app) {
  app.get('/economist', async (req, reply) => {
    const [sectors, sectorTrend, socShare, medianYearly, wageGrowth] = await Promise.all([
      naicsSectorSummary(),
      naicsSectorByYear(),
      socShareByYear(),
      medianWageByYear(),
      wageGrowthTopOccupations({ limit: 5 }),
    ]);
    return reply.view('economist.ejs', {
      title: 'Economist',
      active: 'economist',
      sectors,
      sectorTrend,
      socShare,
      medianYearly,
      wageGrowth,
    });
  });
}
