import {
  classificationSourceMix,
  confidenceDistribution,
  coverageStats,
  entityResolutionLayerMix,
  topCanonicalsByVolume,
} from '../lib/queries.js';

export default async function academicRoutes(app) {
  app.get('/academic', async (req, reply) => {
    const [sourceMix, confidence, coverage, layerMix, topCanonicals] = await Promise.all([
      classificationSourceMix(),
      confidenceDistribution(),
      coverageStats(),
      entityResolutionLayerMix(),
      topCanonicalsByVolume({ limit: 10 }),
    ]);
    return reply.view('academic.ejs', {
      title: 'Academic / Thesis View',
      active: 'academic',
      sourceMix,
      confidence,
      coverage,
      layerMix,
      topCanonicals,
    });
  });
}
