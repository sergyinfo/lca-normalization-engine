import {
  filingsByYear,
  medianWageByYear,
  stateShareByYear,
  wageGrowthTopOccupations,
  caseStatusBreakdown,
} from '../lib/queries.js';

export default async function policyRoutes(app) {
  app.get('/policy', async (req, reply) => {
    const [yearly, medianWage, stateMix, wageGrowth, caseStatus] = await Promise.all([
      filingsByYear(),
      medianWageByYear(),
      stateShareByYear(),
      wageGrowthTopOccupations({ limit: 5 }),
      caseStatusBreakdown(),
    ]);
    return reply.view('policy.ejs', {
      title: 'Policy View',
      active: 'policy',
      yearly,
      medianWage,
      stateMix,
      wageGrowth,
      caseStatus,
    });
  });
}
