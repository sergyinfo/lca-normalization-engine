/**
 * DOL release-page checker. Scheduled by EventBridge every 6 hours.
 *
 * Strategy: HEAD the DOL releases page, compare its ETag (or Last-Modified
 * if ETag missing) against the value we stashed in SSM the last time we
 * looked. If it changed, kick off the build pipeline.
 *
 * This avoids parsing HTML on every poll. If DOL ever stops emitting an
 * ETag/Last-Modified, fall back to fetching the page and hashing the body.
 */

import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import {
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import { createHash } from 'node:crypto';

const ssm = new SSMClient({});
const sfn = new SFNClient({});

const DOL_URL          = process.env.DOL_URL;
const LAST_ETAG_PARAM  = process.env.LAST_ETAG_PARAM;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

export const handler = async () => {
  if (!DOL_URL || !LAST_ETAG_PARAM || !STATE_MACHINE_ARN) {
    throw new Error('Missing required env vars');
  }

  // 1. HEAD the page; cheaper than GET when ETag suffices.
  const head = await fetch(DOL_URL, { method: 'HEAD' });
  let fingerprint = head.headers.get('etag') ?? head.headers.get('last-modified');

  // 2. If neither header is present, GET + hash the body as a fallback.
  if (!fingerprint) {
    const res = await fetch(DOL_URL);
    const body = await res.text();
    fingerprint = createHash('sha256').update(body).digest('hex');
  }

  // 3. Compare with stored value.
  const prev = await ssm
    .send(new GetParameterCommand({ Name: LAST_ETAG_PARAM }))
    .then((r) => r.Parameter?.Value)
    .catch(() => 'none');

  if (prev === fingerprint) {
    return { changed: false, fingerprint };
  }

  // 4. New release detected — trigger Step Functions.
  await sfn.send(new StartExecutionCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    name: `dol-trigger-${Date.now()}`,
    input: JSON.stringify({
      trigger: 'dol-page-change',
      previousFingerprint: prev,
      newFingerprint: fingerprint,
      detectedAt: new Date().toISOString(),
    }),
  }));

  // 5. Persist the new fingerprint so we don't double-fire next time.
  await ssm.send(new PutParameterCommand({
    Name: LAST_ETAG_PARAM,
    Value: fingerprint,
    Overwrite: true,
    Type: 'String',
  }));

  return { changed: true, prev, fingerprint };
};
