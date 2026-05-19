import {
  listSocOptions,
  careerLadderForSoc,
  bestStatesForSoc,
  topEmployersForSoc,
  wageTrendForSoc,
} from '../lib/queries.js';

const DEFAULT_SOC = '15-1252';

export default async function studentRoutes(app) {
  app.get('/student', async (req, reply) => {
    const soc = (req.query.soc || DEFAULT_SOC).toString().trim();
    const [socOptions, ladder, states, employers, trend] = await Promise.all([
      listSocOptions({ limit: 200 }),
      careerLadderForSoc({ socCode: soc }),
      bestStatesForSoc({ socCode: soc, limit: 10 }),
      topEmployersForSoc({ socCode: soc, limit: 15 }),
      wageTrendForSoc({ socCode: soc }),
    ]);
    const selectedTitle =
      socOptions.find((o) => o.soc_code === soc)?.soc_title ?? '';
    return reply.view('student.ejs', {
      title: 'Student / Career Planner',
      active: 'student',
      soc,
      selectedTitle,
      socOptions,
      ladder,
      states,
      employers,
      trend,
    });
  });
}
