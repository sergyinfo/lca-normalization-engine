#!/usr/bin/env node
/**
 * CDK app entry point. Three stacks, deployed in order:
 *
 *   1. LcaSharedStack       — S3 buckets, Secrets Manager, ECR repo
 *   2. LcaDataPipelineStack — burst data ops (EventBridge → Step Fn → EC2)
 *   3. LcaServeStack        — CloudFront + Lambda Container + S3 static
 *
 * Region/account come from CDK context or your AWS profile.
 */

import { App } from 'aws-cdk-lib';
import { LcaSharedStack } from '../lib/shared-stack.js';
import { LcaDataPipelineStack } from '../lib/data-pipeline-stack.js';
import { LcaServeStack } from '../lib/serve-stack.js';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const shared = new LcaSharedStack(app, 'LcaSharedStack', {
  env,
  description: 'Shared resources for the LCA analytics deployment: S3 buckets, secrets, ECR repo.',
});

new LcaDataPipelineStack(app, 'LcaDataPipelineStack', {
  env,
  shared,
  description: 'Quarterly burst pipeline: EventBridge → DOL-checker Lambda → Step Functions → ephemeral EC2 → lca.db in S3.',
});

new LcaServeStack(app, 'LcaServeStack', {
  env,
  shared,
  description: 'Always-on serving: CloudFront + Lambda Container Image (Next.js) + S3 static origin.',
});
