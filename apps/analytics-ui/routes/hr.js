import {
  listSocOptions,
  hrBenchmark,
  wageByLevelForSoc,
  topStatesForSoc,
  wagePercentilesByTopSoc,
} from '../lib/queries.js';

const DEFAULT_SOC = '15-1252';

export default async function hrRoutes(app) {
  app.get('/hr', async (req, reply) => {
    const filters = {
      soc: (req.query.soc || DEFAULT_SOC).toString().trim(),
      state: (req.query.state || '').toString().trim().toUpperCase().slice(0, 2),
    };
    const [socOptions, benchmark, byLevel, byState, allSocs] = await Promise.all([
      listSocOptions({ limit: 200 }),
      hrBenchmark({ socCode: filters.soc, state: filters.state || null }),
      wageByLevelForSoc({ socCode: filters.soc }),
      topStatesForSoc({ socCode: filters.soc, limit: 15 }),
      wagePercentilesByTopSoc({ limit: 15 }),
    ]);
    const selectedTitle =
      socOptions.find((o) => o.soc_code === filters.soc)?.soc_title ?? '';
    return reply.view('hr.ejs', {
      title: 'HR / Compensation',
      active: 'hr',
      filters,
      socOptions,
      benchmark,
      byLevel,
      byState,
      allSocs,
      selectedTitle,
    });
  });
}
