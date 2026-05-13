import {
  wagePercentilesByTopSoc,
  wageLookup,
  topEmployersForSoc,
  wageTrendForSoc,
  listSocOptions,
} from '../lib/queries.js';

export default async function jobseekerRoutes(app) {
  app.get('/jobseeker', async (req, reply) => {
    const { soc, state, city } = req.query;
    const socOptions = await listSocOptions({ limit: 80 });
    const defaultSoc = soc || socOptions[0]?.soc_code || '15-1252';

    const [wagesByTopSoc, lookup, employers, trend] = await Promise.all([
      wagePercentilesByTopSoc({ limit: 10 }),
      wageLookup({ socCode: defaultSoc, state: state || null, city: city || null }),
      topEmployersForSoc({ socCode: defaultSoc, limit: 15 }),
      wageTrendForSoc({ socCode: defaultSoc }),
    ]);
    const selectedTitle = socOptions.find(o => o.soc_code === defaultSoc)?.soc_title || '';

    return reply.view('jobseeker.ejs', {
      title: 'Job Seeker View',
      active: 'jobseeker',
      socOptions,
      filters: { soc: defaultSoc, state: state || '', city: city || '' },
      selectedTitle,
      wagesByTopSoc,
      lookup,
      employers,
      trend,
    });
  });
}
