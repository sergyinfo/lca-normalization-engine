import {
  wagePremiumBySoc,
  stateConcentration,
  highWithdrawalSponsors,
} from '../lib/queries.js';

export default async function workerRightsRoutes(app) {
  app.get('/worker-rights', async (req, reply) => {
    const [premium, concentration, churn] = await Promise.all([
      wagePremiumBySoc({ limit: 25 }),
      stateConcentration(),
      highWithdrawalSponsors({ limit: 25, minFilings: 100 }),
    ]);
    return reply.view('worker-rights.ejs', {
      title: 'Worker Rights',
      active: 'worker-rights',
      premium,
      concentration,
      churn,
    });
  });
}
