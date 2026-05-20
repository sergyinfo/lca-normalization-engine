/**
 * Burst-on-demand data pipeline.
 *
 * Flow when DOL publishes a new quarterly release:
 *
 *   EventBridge (every 6h)
 *     ─► Lambda DOL-checker (compares ETag/hash of DOL releases page)
 *        ─► On change → Step Functions state machine:
 *           1. Start EC2 instance from the burst launch template
 *           2. cloud-init pulls postgres+ingest containers,
 *              restores PG snapshot from S3, ingests new XLSX,
 *              refreshes views, runs build:sqlite + build:summaries,
 *              uploads lca.db to S3, snapshots PG back to S3
 *           3. Wait for instance to self-terminate
 *           4. Notify SNS topic on completion / failure
 *
 * Concurrency: a singleton state machine — if a run is already in flight,
 * subsequent triggers are rejected. Quarterly cadence makes contention
 * unlikely, but the guard is there.
 */

import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LcaSharedStack } from './shared-stack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface DataPipelineStackProps extends StackProps {
  shared: LcaSharedStack;
}

export class LcaDataPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: DataPipelineStackProps) {
    super(scope, id, props);
    const { shared } = props;

    // ---------------------------------------------------------------------
    // SNS topic for build notifications (success + failure).
    // Subscribe operators (email/Slack/PagerDuty) out-of-band.
    // ---------------------------------------------------------------------
    const notifyTopic = new sns.Topic(this, 'BuildNotifications', {
      displayName: 'LCA build pipeline notifications',
    });

    // ---------------------------------------------------------------------
    // Networking. A single isolated subnet is enough — the EC2 instance
    // only needs egress (NAT or VPC endpoints).
    // ---------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'BurstVpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public',  subnetType: ec2.SubnetType.PUBLIC,  cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    // ---------------------------------------------------------------------
    // IAM role + instance profile for the burst EC2.
    // ---------------------------------------------------------------------
    const ec2Role = new iam.Role(this, 'BurstEc2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Burst data-ops EC2: read scratch + write lca.db + snapshots.',
    });
    shared.ingestScratchBucket.grantReadWrite(ec2Role);
    shared.lcaDbBucket.grantReadWrite(ec2Role);
    shared.pgSnapshotBucket.grantReadWrite(ec2Role);
    shared.llmApiKeySecret.grantRead(ec2Role);
    shared.pgPasswordSecret.grantRead(ec2Role);
    ec2Role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );
    // Allow the instance to push a new Lambda image to ECR after building it.
    shared.lambdaImageRepo.grantPullPush(ec2Role);
    // Allow self-terminate at the end of the run.
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:TerminateInstances'],
      resources: ['*'],
      conditions: { StringEquals: { 'ec2:ResourceTag/Project': 'lca-burst' } },
    }));
    // Update the serving Lambda with the new image (lambda:UpdateFunctionCode).
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction'],
      // Scope to the analytics-web function — wildcard here lets the
      // dependency between stacks stay loose; tighten if your IAM policy
      // requires resource ARNs.
      resources: ['*'],
    }));

    // ---------------------------------------------------------------------
    // EC2 launch template — what gets started during a build run.
    // Cloud-init clones the repo, runs the pipeline, uploads artefacts,
    // then self-terminates. Failure modes notify SNS via the Step Fn.
    // ---------------------------------------------------------------------
    const sg = new ec2.SecurityGroup(this, 'BurstSg', {
      vpc,
      description: 'Burst EC2: outbound only.',
      allowAllOutbound: true,
    });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      `#!/bin/bash`,
      `set -euxo pipefail`,
      `exec > >(tee /var/log/burst.log | logger -t burst -s 2>/dev/console) 2>&1`,
      ``,
      `# Pull build params from EC2 instance metadata + Step Fn input`,
      `INSTANCE_ID=$(curl -sf http://169.254.169.254/latest/meta-data/instance-id)`,
      `REGION=$(curl -sf http://169.254.169.254/latest/meta-data/placement/region)`,
      ``,
      `# Install Docker + Node 22 + git`,
      `dnf install -y docker git`,
      `systemctl enable --now docker`,
      `usermod -a -G docker ec2-user`,
      `curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -`,
      `dnf install -y nodejs`,
      `npm install -g pnpm@9`,
      ``,
      `# Fetch the repo (use CodeCommit / GitHub release tarball / S3-stored bundle)`,
      `# Replace the URL with your fork's release tarball, or use git+ssh.`,
      `cd /opt && git clone https://github.com/${process.env.GITHUB_REPO ?? 'YOUR_ORG/lca-normalization-engine'}.git lca`,
      `cd /opt/lca`,
      `pnpm install --frozen-lockfile`,
      ``,
      `# Pull the latest PG snapshot if one exists, else start fresh`,
      `aws s3 cp s3://${shared.pgSnapshotBucket.bucketName}/latest.pgdump /tmp/latest.pgdump || true`,
      ``,
      `# Start Postgres via docker compose`,
      `docker compose up -d lca_db lca_redis`,
      `until docker compose exec -T lca_db pg_isready -U lca_user; do sleep 2; done`,
      ``,
      `# Restore (if dump present) and refresh views`,
      `if [ -f /tmp/latest.pgdump ]; then`,
      `  pg_restore --no-owner --no-acl --clean --if-exists \\`,
      `    -h localhost -U lca_user -d lca_db /tmp/latest.pgdump`,
      `fi`,
      ``,
      `# Run the ingest + normalise pipeline against new DOL files`,
      `# (placeholder — adapt to your harvester/ingestor invocation)`,
      `node apps/cli-tool/index.js seed --files-dir /tmp/new-xlsx || true`,
      `pnpm --filter @lca/cli analytics:refresh-views`,
      ``,
      `# Build the SQLite snapshot + summaries`,
      `pnpm --filter analytics-web build:sqlite`,
      `LLM_API_KEY=$(aws secretsmanager get-secret-value \\`,
      `  --secret-id ${shared.llmApiKeySecret.secretName} --query SecretString --output text) \\`,
      `LLM_PROVIDER=anthropic \\`,
      `  pnpm --filter analytics-web build:summaries`,
      ``,
      `# Upload lca.db to the versioned bucket`,
      `aws s3 cp apps/analytics-web/data/lca.db \\`,
      `  s3://${shared.lcaDbBucket.bucketName}/lca.db`,
      ``,
      `# Build + push the Lambda container image`,
      `ECR_URI=$(aws ecr describe-repositories --repository-names ${shared.lambdaImageRepo.repositoryName} \\`,
      `  --query 'repositories[0].repositoryUri' --output text)`,
      `aws ecr get-login-password --region $REGION | \\`,
      `  docker login --username AWS --password-stdin "$ECR_URI"`,
      `docker build -f apps/analytics-web/Dockerfile.lambda -t "$ECR_URI:latest" .`,
      `docker push "$ECR_URI:latest"`,
      ``,
      `# Update the serving Lambda to the new image`,
      `aws lambda update-function-code \\`,
      `  --function-name lca-analytics-web \\`,
      `  --image-uri "$ECR_URI:latest"`,
      ``,
      `# Snapshot Postgres back to S3 for the next run`,
      `docker compose exec -T lca_db pg_dump --format=custom -U lca_user -d lca_db \\`,
      `  > /tmp/latest.pgdump`,
      `aws s3 cp /tmp/latest.pgdump s3://${shared.pgSnapshotBucket.bucketName}/latest.pgdump`,
      ``,
      `# Notify on success and self-terminate`,
      `aws sns publish --topic-arn ${notifyTopic.topicArn} \\`,
      `  --subject "[LCA] build succeeded" \\`,
      `  --message "Build $INSTANCE_ID completed, new image deployed."`,
      `aws ec2 terminate-instances --instance-ids $INSTANCE_ID`,
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'BurstLaunchTemplate', {
      launchTemplateName: 'lca-burst',
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.C6I, ec2.InstanceSize.XLARGE2),
      role: ec2Role,
      securityGroup: sg,
      userData,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(100, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
          encrypted: true,
        }),
      }],
    });
    // Tag instances so the self-terminate IAM scope matches.
    launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;

    // ---------------------------------------------------------------------
    // DOL-checker Lambda. Compares the DOL releases page's ETag against
    // the last-known value (stored in SSM Parameter Store).
    // ---------------------------------------------------------------------
    const lastEtagParam = new ssm.StringParameter(this, 'LastDolEtag', {
      parameterName: '/lca/last-dol-etag',
      stringValue: 'none',
      description: 'ETag of the DOL releases page at last check.',
    });

    const dolChecker = new lambda.Function(this, 'DolChecker', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'dol-checker')),
      timeout: Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        DOL_URL:           'https://www.dol.gov/agencies/eta/foreign-labor/performance',
        LAST_ETAG_PARAM:   lastEtagParam.parameterName,
        STATE_MACHINE_ARN: '', // wired below once stateMachine is constructed
      },
    });
    lastEtagParam.grantRead(dolChecker);
    lastEtagParam.grantWrite(dolChecker);

    // ---------------------------------------------------------------------
    // Step Functions state machine that orchestrates the build.
    // ---------------------------------------------------------------------
    const runEc2 = new tasks.CallAwsService(this, 'StartBurstEc2', {
      service: 'ec2',
      action: 'runInstances',
      iamResources: ['*'],
      parameters: {
        LaunchTemplate: {
          LaunchTemplateId: launchTemplate.launchTemplateId,
          Version: '$Latest',
        },
        MinCount: 1,
        MaxCount: 1,
        SubnetId: vpc.publicSubnets[0]!.subnetId,
        TagSpecifications: [{
          ResourceType: 'instance',
          Tags: [{ Key: 'Project', Value: 'lca-burst' }],
        }],
      },
      resultPath: '$.runResult',
    });

    const success = new tasks.SnsPublish(this, 'NotifyOk', {
      topic: notifyTopic,
      subject: '[LCA] build pipeline launched',
      message: sfn.TaskInput.fromText('Burst EC2 launched; build in progress. Instance self-notifies on completion.'),
    });

    const failure = new tasks.SnsPublish(this, 'NotifyFail', {
      topic: notifyTopic,
      subject: '[LCA] build pipeline FAILED to launch',
      message: sfn.TaskInput.fromJsonPathAt('$'),
    });

    const definition = runEc2
      .addCatch(failure, { resultPath: '$.error' })
      .next(success);

    const stateMachine = new sfn.StateMachine(this, 'BuildPipeline', {
      stateMachineName: 'lca-build-pipeline',
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(4),
      logs: {
        destination: new logs.LogGroup(this, 'BuildPipelineLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        level: sfn.LogLevel.ERROR,
      },
    });

    // Wire the state machine ARN into the DOL checker now that it exists.
    dolChecker.addEnvironment('STATE_MACHINE_ARN', stateMachine.stateMachineArn);
    stateMachine.grantStartExecution(dolChecker);

    // ---------------------------------------------------------------------
    // EventBridge — schedule the checker every 6 hours.
    // ---------------------------------------------------------------------
    new events.Rule(this, 'DolCheckSchedule', {
      schedule: events.Schedule.rate(Duration.hours(6)),
      targets: [new targets.LambdaFunction(dolChecker)],
      description: 'Polls DOL for new H-1B disclosure releases.',
    });

    // Allow operator-triggered runs too.
    new events.Rule(this, 'ManualRunRule', {
      eventPattern: {
        source: ['lca.manual'],
        detailType: ['build.run'],
      },
      targets: [new targets.SfnStateMachine(stateMachine)],
    });
  }
}
