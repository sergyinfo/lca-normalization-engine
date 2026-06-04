#!/usr/bin/env node
/**
 * CDK app entry point. Three stacks, deployed in order:
 *
 *   1. LcaSharedStack       — S3 buckets, Secrets Manager, ECR repo
 *   2. LcaDataPipelineStack — burst data ops (EventBridge → Step Fn → EC2)
 *   3. LcaServeStack        — CloudFront + Lambda Container + S3 static
 *
 * Region/account come from CDK context or your AWS profile.
 *
 * Tagging: every taggable resource in every stack gets the project-wide
 * tags below via CDK propagation (Tags.of(app).add). Each stack
 * additionally tags its tree with a Component tag for sub-system
 * filtering in Cost Explorer / Resource Groups.
 */

import { App, Tags } from 'aws-cdk-lib';
import { LcaSharedStack } from '../lib/shared-stack.js';
import { LcaDataPipelineStack } from '../lib/data-pipeline-stack.js';
import { LcaServeStack } from '../lib/serve-stack.js';
import { LcaBudgetsStack } from '../lib/budgets-stack.js';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// ---------------------------------------------------------------------------
// Project-wide tags. Propagated to every taggable resource in every stack.
// Pick consistent values once — Cost Explorer groups by these, Resource
// Groups filter by these, IAM policies can use them as conditions.
// ---------------------------------------------------------------------------
const projectTags: Record<string, string> = {
  Project:     'h1b-report',
  ManagedBy:   'cdk',
  Repository:  'lca-normalization-engine',
  Environment: process.env.LCA_ENVIRONMENT ?? 'prod',
};
for (const [key, value] of Object.entries(projectTags)) {
  Tags.of(app).add(key, value);
}

const shared = new LcaSharedStack(app, 'LcaSharedStack', {
  env,
  description: 'Shared resources for the LCA analytics deployment: S3 buckets, secrets, ECR repo.',
});

new LcaDataPipelineStack(app, 'LcaDataPipelineStack', {
  env,
  shared,
  description: 'Quarterly burst pipeline: EventBridge → DOL-checker Lambda → Step Functions → ephemeral EC2 → lca.db in S3.',
});

// Two independent serving stacks (separate CloudFront distro + Lambda + image
// tag each), so dev can run an experimental build without touching prod:
//   cdk deploy LcaServeStack     -c siteCertificateArn=… -c originVerifySecret=…  (dev)
//   cdk deploy LcaServeProdStack -c siteCertificateArn=… -c originVerifySecret=…  (prod)
// Dev = current live config (dev.h1b.report, noindex, image :latest) — unchanged.
new LcaServeStack(app, 'LcaServeStack', {
  env,
  shared,
  description: 'Serving (dev): CloudFront + Lambda Container Image — dev.h1b.report, noindex, :latest.',
  site: {
    envName: 'dev',
    aliasDomains: ['dev.h1b.report'],
    siteUrl: 'https://dev.h1b.report',
    indexableHosts: [],                    // dev never competes with prod
    imageTag: 'latest',
    functionName: 'lca-analytics-web',
  },
});

// Prod = h1b.report apex (www 301s to apex), indexable, image :prod.
new LcaServeStack(app, 'LcaServeProdStack', {
  env,
  shared,
  description: 'Serving (prod): CloudFront + Lambda Container Image — h1b.report, indexable, :prod.',
  site: {
    envName: 'prod',
    aliasDomains: ['h1b.report', 'www.h1b.report'],
    canonicalHosts: ['h1b.report'],        // 301 www → apex
    siteUrl: 'https://h1b.report',
    indexableHosts: ['h1b.report', 'www.h1b.report'],
    imageTag: 'prod',
    functionName: 'lca-analytics-web-prod',
  },
});

new LcaBudgetsStack(app, 'LcaBudgetsStack', {
  env,
  description: 'AWS Budgets + Cost Anomaly Detection. Email alerts via LCA_BILLING_EMAIL.',
  // All thresholds also read from env vars; explicit props here as a
  // safety net (see lib/budgets-stack.ts for the full list).
});
