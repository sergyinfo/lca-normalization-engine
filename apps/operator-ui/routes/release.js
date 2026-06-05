/**
 * Release-control routes. The operator UI holds NO prod-deploy IAM — these
 * endpoints only publish an EventBridge event (lca.operator/*). The matching
 * Step Function (PromotePipeline / TeardownPipeline / RebuildPreviewPipeline,
 * see infra/aws/lib/data-pipeline-stack.ts) does the privileged work via SSM
 * RunCommand on this same box.
 *
 * Only available on the burst review box, where INSTANCE_ID is injected. On a
 * laptop / local compose it's absent and the buttons report a clear error.
 */

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const REGION = process.env.AWS_REGION || 'us-east-1';
const EVENT_SOURCE = process.env.EVENT_SOURCE || 'lca.operator';
const client = new EventBridgeClient({ region: REGION });

async function emit(detailType) {
  const instanceId = process.env.INSTANCE_ID;
  if (!instanceId) {
    throw new Error('INSTANCE_ID unset — release controls only work on the review box.');
  }
  await client.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: EVENT_SOURCE,
          DetailType: detailType,
          Detail: JSON.stringify({ instanceId, release: process.env.RELEASE || null }),
        },
      ],
    }),
  );
}

export default async function releaseRoutes(app) {
  const action = (detailType, okFlash) => async (req, reply) => {
    try {
      await emit(detailType);
      return reply.redirect(`/?flash=${okFlash}`);
    } catch (err) {
      app.log.error({ err }, 'release.dispatch_failed');
      return reply.redirect('/?flash=missing_instance_id');
    }
  };

  app.post('/release/promote', action('promote.run', 'promote_dispatched'));
  app.post('/release/preview', action('preview.run', 'preview_dispatched'));
  app.post('/release/shutdown', action('teardown.run', 'teardown_dispatched'));
}
