/**
 * Shared resources used by both the data pipeline and the serving stack.
 *
 * What lives here:
 *   - S3 bucket for versioned lca.db artefacts (the bridge between the two)
 *   - S3 bucket for Postgres snapshots (between quarterly runs)
 *   - S3 bucket for ingest scratch space (raw DOL XLSX downloads)
 *   - Secrets Manager entries for LLM API keys + Postgres password
 *   - ECR repository for the Lambda container image
 *
 * Everything is exposed as public stack properties so the other two
 * stacks can grant fine-grained IAM access to specific resources.
 */

import { Stack, StackProps, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';

export class LcaSharedStack extends Stack {
  /** Holds the lca.db snapshots (versioned). Object key: `lca.db` plus history via versioning. */
  public readonly lcaDbBucket: s3.Bucket;
  /** Postgres snapshots between quarterly runs. */
  public readonly pgSnapshotBucket: s3.Bucket;
  /** Raw DOL XLSX downloads (scratch). */
  public readonly ingestScratchBucket: s3.Bucket;
  /** ECR repo holding the Next.js Lambda container image. */
  public readonly lambdaImageRepo: ecr.Repository;
  /** Secret holding the Anthropic API key for build:summaries. */
  public readonly llmApiKeySecret: sm.Secret;
  /** Secret holding the Postgres password used by the ephemeral EC2 instances. */
  public readonly pgPasswordSecret: sm.Secret;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Component tag — lets Cost Explorer / Resource Groups split costs and
    // listings per sub-system within the project.
    Tags.of(this).add('Component', 'shared');

    // ---- S3: lca.db artefacts (the build artefact that crosses stacks) ----
    this.lcaDbBucket = new s3.Bucket(this, 'LcaDbBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{
        // Drop noncurrent versions after 1 year — keeps the bucket sane while
        // still allowing point-in-time rollback for ~4 quarters.
        noncurrentVersionExpiration: Duration.days(365),
      }],
      removalPolicy: RemovalPolicy.RETAIN, // never auto-delete production data
    });

    // ---- S3: Postgres snapshots ----
    this.pgSnapshotBucket = new s3.Bucket(this, 'PgSnapshotBucket', {
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{
        // Keep the last ~2 years of snapshots; older ones removed automatically.
        expiration: Duration.days(730),
      }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- S3: ingest scratch (raw DOL XLSX) ----
    this.ingestScratchBucket = new s3.Bucket(this, 'IngestScratchBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{
        // Scratch — drop everything older than 30 days.
        expiration: Duration.days(30),
      }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---- ECR: Lambda image registry ----
    this.lambdaImageRepo = new ecr.Repository(this, 'LambdaImageRepo', {
      repositoryName: 'lca-analytics-web',
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{
        description: 'Keep the last 10 image tags',
        maxImageCount: 10,
      }],
    });

    // ---- Secrets Manager: Anthropic key ----
    this.llmApiKeySecret = new sm.Secret(this, 'LlmApiKeySecret', {
      secretName: 'lca/llm-api-key',
      description: 'Anthropic / OpenAI API key for the build:summaries step.',
      // Operator populates the value out-of-band after stack creation —
      // CDK shouldn't bake real keys into source.
    });

    // ---- Secrets Manager: Postgres password ----
    this.pgPasswordSecret = new sm.Secret(this, 'PgPasswordSecret', {
      secretName: 'lca/pg-password',
      description: 'Password for the ephemeral Postgres on burst-build EC2.',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    });
  }
}
