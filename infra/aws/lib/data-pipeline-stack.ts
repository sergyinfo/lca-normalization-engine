/**
 * Burst-on-demand data pipeline (human-gated release).
 *
 * DOL's WAF blocks AWS IP ranges, so release detection + download run OFF-AWS:
 * the dol-watch agent on a residential machine (infra/mac) scrapes DOL, uploads a
 * new Disclosure file to the S3 inbox (s3://<scratch>/incoming/), and fires the
 * `lca.manual/build.run` EventBridge event. From there:
 *
 *   ManualRunRule ─► Step Functions:
 *     CheckBurstRunning → AlreadyRunning? (single-flight)
 *       └─ else StartBurstEc2 (Graviton/arm64):
 *            sync the S3 inbox → (empty? notify + self-terminate, cheap)
 *            restore PG snapshot → ingest (harvester LOCAL mode, supersede)
 *            → NLP normalise → build candidate lca.db → dev.h1b.report preview
 *            → operator-ui at operator.h1b.report → SNS "ready for review"
 *       operator: Promote (ship to prod) / Rebuild preview / Shut down
 *
 * Single-flight + the inline 36h watchdog cap cost; the on-box failure trap
 * SNS-notifies and leaves the box for debugging.
 */

import { Stack, StackProps, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { LcaSharedStack } from './shared-stack.js';

interface DataPipelineStackProps extends StackProps {
  shared: LcaSharedStack;
}

export class LcaDataPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: DataPipelineStackProps) {
    super(scope, id, props);
    const { shared } = props;

    Tags.of(this).add('Component', 'data-pipeline');

    // ---------------------------------------------------------------------
    // SNS topic for build notifications (success + failure).
    // Subscribe operators (email/Slack/PagerDuty) out-of-band.
    // ---------------------------------------------------------------------
    const notifyTopic = new sns.Topic(this, 'BuildNotifications', {
      displayName: 'LCA build pipeline notifications',
    });
    // Subscribe the ops email in-code when LCA_OPS_EMAIL is set at synth time
    // (confirm the subscription from the email AWS sends). Falls back to the
    // out-of-band `aws sns subscribe` flow if unset.
    const opsEmail = process.env.LCA_OPS_EMAIL?.trim();
    if (opsEmail) {
      notifyTopic.addSubscription(new subs.EmailSubscription(opsEmail));
    }

    // ---------------------------------------------------------------------
    // Pre-create CloudWatch log groups so retention is IaC-managed (not
    // left to the CloudWatch Agent's defaults). Every piece of the burst
    // pipeline streams into one of these:
    //
    //   /lca/burst/userdata    ← cloud-init `userData.addCommands(...)` output
    //   /lca/burst/cloud-init  ← Amazon Linux's own cloud-init logs
    //
    // The EC2 self-terminates at the end of the run, so without shipping
    // these to CloudWatch the logs are LOST. The CW Agent (below) ships
    // /var/log/burst.log here. (We do NOT override Docker's log-driver to
    // awslogs — that made dockerd fail to start; container stdout stays on
    // the box. The pipeline's own output runs on the host, so it's captured.)
    // ---------------------------------------------------------------------
    const userdataLogGroup = new logs.LogGroup(this, 'BurstUserdataLogs', {
      logGroupName: '/lca/burst/userdata',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const cloudInitLogGroup = new logs.LogGroup(this, 'BurstCloudInitLogs', {
      logGroupName: '/lca/burst/cloud-init',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
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
    // Operator-UI + Cloudflare credentials read by the keep-alive review env.
    shared.operatorPasswordSecret.grantRead(ec2Role);
    shared.sessionSecret.grantRead(ec2Role);
    shared.cloudflareTokenSecret.grantRead(ec2Role);
    ec2Role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );
    // CloudWatch Agent + Docker awslogs driver need to create/write log
    // streams against the pre-created groups above. The managed policy
    // covers PutLogEvents / CreateLogStream / DescribeLogStreams /
    // DescribeLogGroups for the agent's typical needs.
    ec2Role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
    );
    // Allow the instance to push a new Lambda image to ECR after building it.
    shared.lambdaImageRepo.grantPullPush(ec2Role);
    // Allow self-terminate at the end of the run. Scoped by the
    // BurstWorker=true tag that runInstances explicitly stamps on the
    // instance (see TagSpecifications below). A separate tag-key from
    // the project-wide Project tag, so the IAM condition can't be
    // satisfied by something tagged Project=h1b-report alone.
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:TerminateInstances'],
      resources: ['*'],
      conditions: { StringEquals: { 'ec2:ResourceTag/BurstWorker': 'true' } },
    }));
    // Update the serving Lambdas with the new image (lambda:UpdateFunctionCode).
    // Covers BOTH the dev function (lca-analytics-web, candidate preview) and the
    // prod function (lca-analytics-web-prod, written by the Promote step).
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration'],
      // Wildcard keeps the cross-stack dependency loose; tighten to the two
      // function ARNs if your IAM policy requires it.
      resources: ['*'],
    }));
    // Bust the dev + prod CloudFront edge caches after a content deploy.
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation'],
      resources: ['*'],
    }));
    // Resolve the serve stacks' DistributionId outputs (for cache invalidation).
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: ['*'],
    }));
    // The operator UI publishes promote/teardown events to the default bus.
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [`arn:aws:events:${this.region}:${this.account}:event-bus/default`],
    }));
    // The user-data + promote/teardown scripts publish progress to the topic.
    notifyTopic.grantPublish(ec2Role);

    // ---------------------------------------------------------------------
    // GitHub token — the burst EC2 clones the (private) repo to run the
    // pipeline. A fine-grained, read-only Contents PAT lives here. CDK
    // auto-generates a random placeholder on first deploy; replace it with
    // your real PAT before the first burst run:
    //
    //   aws secretsmanager put-secret-value \
    //     --secret-id lca/github-token --secret-string 'github_pat_…'
    // ---------------------------------------------------------------------
    const githubTokenSecret = new secretsmanager.Secret(this, 'GithubToken', {
      secretName: 'lca/github-token',
      description: 'Fine-grained read-only GitHub PAT for the burst EC2 to clone the private repo. Populate manually after deploy.',
    });
    githubTokenSecret.grantRead(ec2Role);

    // (Static assets are served by the Lambda image, not a separate S3 bucket,
    // so the burst doesn't need S3 static-write access — pushing the new image
    // is enough.)

    // ---------------------------------------------------------------------
    // EC2 launch template — what gets started during a build run.
    // Cloud-init clones the repo, runs the pipeline, uploads artefacts,
    // then self-terminates. Failure modes notify SNS via the Step Fn.
    // ---------------------------------------------------------------------
    const sg = new ec2.SecurityGroup(this, 'BurstSg', {
      vpc,
      description: 'Burst EC2: outbound + inbound 80/443 for the operator site.',
      allowAllOutbound: true,
    });
    // operator.h1b.report is served directly off this box by Caddy (grey-cloud
    // A-record → public IP). Allow HTTPS (+ HTTP for the ACME/redirect path).
    // The UI itself is password-gated; only the login page is exposed.
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'operator UI (HTTPS via Caddy)');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP for ACME and HTTPS redirect');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      `#!/bin/bash`,
      `set -euxo pipefail`,
      `exec > >(tee /var/log/burst.log | logger -t burst -s 2>/dev/console) 2>&1`,
      ``,
      `# Pull build params from EC2 instance metadata. IMDSv2 is REQUIRED on this`,
      `# launch template (HttpTokens=required), so every metadata call must carry a`,
      `# session token — a plain IMDSv1 GET returns 401 and would abort the script.`,
      `IMDS_TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")`,
      `imds() { curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }`,
      `INSTANCE_ID=$(imds instance-id)`,
      `REGION=$(imds placement/region)`,
      ``,
      `# Cost backstop, armed AS EARLY AS POSSIBLE (before any step that can fail):`,
      `# self-terminate after 36h no matter what. A repo-dependent teardown (DNS`,
      `# cleanup) runs on the operator Shut-down path; this inline one only needs`,
      `# the instance id, so a failure anywhere later can never leak a running box.`,
      `( sleep 129600; aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" ) \\`,
      `  >/var/log/watchdog.log 2>&1 &`,
      ``,
      `# On any hard failure (set -e), notify so it's caught promptly. The box is`,
      `# LEFT UP for debugging (logs in /lca/burst/userdata); the 36h watchdog`,
      `# above still terminates it, so cost stays bounded. The "no new data" path`,
      `# exits 0 cleanly and does not trip this trap.`,
      `trap 'aws sns publish --region "$REGION" --topic-arn ${notifyTopic.topicArn} --subject "[LCA] burst FAILED (\${RELEASE:-pending})" --message "Burst $INSTANCE_ID failed at line $LINENO. See CloudWatch /lca/burst/userdata. Box stays up for debugging; 36h watchdog will terminate it." || true' ERR`,
      ``,
      `# ----- CloudWatch Agent: ship /var/log/burst.log + cloud-init.log -----`,
      `# Install FIRST so the rest of this script's output is captured in CW.`,
      `dnf install -y amazon-cloudwatch-agent`,
      `mkdir -p /opt/aws/amazon-cloudwatch-agent/etc`,
      `cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'JSON'`,
      `{`,
      `  "agent": { "metrics_collection_interval": 60, "run_as_user": "root" },`,
      `  "logs": {`,
      `    "logs_collected": {`,
      `      "files": {`,
      `        "collect_list": [`,
      `          { "file_path": "/var/log/burst.log",`,
      `            "log_group_name": "${userdataLogGroup.logGroupName}",`,
      `            "log_stream_name": "{instance_id}",`,
      `            "timestamp_format": "%b %d %H:%M:%S",`,
      `            "timezone": "UTC" },`,
      `          { "file_path": "/var/log/cloud-init-output.log",`,
      `            "log_group_name": "${cloudInitLogGroup.logGroupName}",`,
      `            "log_stream_name": "{instance_id}",`,
      `            "timezone": "UTC" },`,
      `          { "file_path": "/var/log/cloud-init.log",`,
      `            "log_group_name": "${cloudInitLogGroup.logGroupName}",`,
      `            "log_stream_name": "{instance_id}.cloud-init",`,
      `            "timezone": "UTC" }`,
      `        ]`,
      `      }`,
      `    }`,
      `  }`,
      `}`,
      `JSON`,
      `/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \\`,
      `  -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s`,
      ``,
      `# ----- Docker (stock config) -----`,
      `# We deliberately DO NOT override the daemon log-driver to awslogs: an`,
      `# invalid default-log config makes dockerd fail to START (which it did on`,
      `# the first run). The pipeline's own progress already ships to CloudWatch`,
      `# via the CW agent (/var/log/burst.log), and the harvest runs on the host,`,
      `# so we keep full visibility without risking the daemon. Container stdout`,
      `# stays on the box (docker compose logs) — fine for an ephemeral build box.`,
      `dnf install -y docker git`,
      `systemctl enable --now docker`,
      `usermod -a -G docker ec2-user`,
      ``,
      `# AL2023's docker package does NOT bundle the Compose v2 plugin, and its`,
      `# bundled buildx (0.12.1) is too old for 'docker compose build' (needs`,
      `# >=0.17.0). Install current arm64 plugin binaries into the CLI plugins dir.`,
      `mkdir -p /usr/libexec/docker/cli-plugins`,
      `curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64" \\`,
      `  -o /usr/libexec/docker/cli-plugins/docker-compose`,
      `curl -fsSL "https://github.com/docker/buildx/releases/download/v0.19.3/buildx-v0.19.3.linux-arm64" \\`,
      `  -o /usr/libexec/docker/cli-plugins/docker-buildx`,
      `chmod +x /usr/libexec/docker/cli-plugins/docker-compose /usr/libexec/docker/cli-plugins/docker-buildx`,
      `docker compose version`,
      `docker buildx version`,
      ``,
      `# ----- Node 22 + pnpm -----`,
      `curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -`,
      `dnf install -y nodejs`,
      `npm install -g pnpm@9`,
      ``,
      `# Fetch the repo. Private repo → clone with a fine-grained read-only PAT`,
      `# pulled from Secrets Manager (lca/github-token). The token never lands`,
      `# on disk and is unset right after the clone.`,
      `GITHUB_TOKEN=$(aws secretsmanager get-secret-value \\`,
      `  --secret-id ${githubTokenSecret.secretName} --query SecretString --output text)`,
      `# Clone the 'develop' branch — that's where the current pipeline code lives`,
      `# (the default branch 'main' is not the working branch and lags behind).`,
      `cd /opt && git clone -b \${BURST_GIT_REF:-develop} https://x-access-token:$GITHUB_TOKEN@github.com/${process.env.GITHUB_REPO ?? 'sergyinfo/lca-normalization-engine'}.git lca`,
      `unset GITHUB_TOKEN`,
      `cd /opt/lca`,
      `pnpm install --frozen-lockfile`,
      ``,
      `# (The 36h cost watchdog was already armed inline right after INSTANCE_ID,`,
      `#  so it covers failures during clone/install too. The operator Shut-down`,
      `#  button does a clean teardown — DNS removal + SNS — sooner.)`,
      ``,
      `# Pull the latest PG snapshot if one exists, else start fresh`,
      `aws s3 cp s3://${shared.pgSnapshotBucket.bucketName}/latest.pgdump /tmp/latest.pgdump || true`,
      ``,
      `# A stable id for this review cycle — used for the candidate S3 key + logs.`,
      `RELEASE=$(date -u +%Y%m%d-%H%M%S)`,
      ``,
      `# Where files live + the container path the ingestor sees. Exported BEFORE`,
      `# 'compose up' so the ingestion-worker mounts the right dir.`,
      `export LOCAL_FILES_DIR=/opt/lca/data/incoming CONTAINER_MOUNT_DIR=/data`,
      `# Worker concurrency (compose reads NLP_WORKER_CONCURRENCY/INGESTOR_CONCURRENCY`,
      `# from the host env). Modest defaults that work on the c7g.2xlarge and scale`,
      `# onto a bigger backfill box; overridable via env.`,
      `export NLP_WORKER_CONCURRENCY=\${NLP_WORKER_CONCURRENCY:-6} INGESTOR_CONCURRENCY=\${INGESTOR_CONCURRENCY:-8}`,
      `mkdir -p $LOCAL_FILES_DIR`,
      ``,
      `# ----- Pull new DOL files from the S3 inbox -----`,
      `# DOL's WAF blocks AWS, so the release check + download run OFF-AWS (the`,
      `# dol-watch agent, infra/mac) and land here: s3://<scratch>/incoming/. Sync them; the`,
      `# harvester (LOCAL mode) applies the same scope/dedup/supersede logic.`,
      `INBOX="s3://${shared.ingestScratchBucket.bucketName}/incoming"`,
      `aws s3 sync "$INBOX/" "$LOCAL_FILES_DIR/" --exclude '*' --include '*.xlsx' --region $REGION`,
      `# find (not 'ls *.xlsx | wc -l'): ls exits non-zero on no match, and with`,
      `# 'set -o pipefail' that would abort the script on an empty inbox.`,
      `FILE_COUNT=$(find "$LOCAL_FILES_DIR" -maxdepth 1 -name '*.xlsx' -type f | wc -l)`,
      `echo "inbox xlsx files: $FILE_COUNT"`,
      ``,
      `# Cheap early exit BEFORE the (~40 min) PG restore: an empty inbox means`,
      `# nothing to do (e.g. a manual trigger with no upload). ~1-min run.`,
      `if [ "$FILE_COUNT" -eq 0 ]; then`,
      `  aws sns publish --region $REGION --topic-arn ${notifyTopic.topicArn} \\`,
      `    --subject "[LCA] no new files in inbox ($RELEASE)" \\`,
      `    --message "S3 inbox empty — nothing to ingest. Terminating the review box."`,
      `  aws ec2 terminate-instances --region $REGION --instance-ids $INSTANCE_ID`,
      `  exit 0`,
      `fi`,
      ``,
      `# Start Postgres + Redis, restore the snapshot, then the ingest/NLP workers`,
      `# (compose SERVICE names). The nlp-worker image build pulls torch (~minutes).`,
      `docker compose up -d db redis`,
      `until docker compose exec -T db pg_isready -U lca_user; do sleep 2; done`,
      `if [ -f /tmp/latest.pgdump ]; then`,
      `  docker compose exec -T db pg_restore --no-owner --no-acl --clean --if-exists \\`,
      `    -U lca_user -d lca_db < /tmp/latest.pgdump`,
      `fi`,
      ``,
      `# A pre-FLAG backfill (FY2018/2019) needs those year partitions, which the`,
      `# restored 2020+ snapshot lacks — create them BEFORE ingest so the rows don't`,
      `# fall into lca_records_overflow. Idempotent (CREATE IF NOT EXISTS); host-side`,
      `# against the published db port (same as the harvester invocation below).`,
      `LCA_PARTITION_START_YEAR=\${LCA_PARTITION_START_YEAR:-2018} \\`,
      `  DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \\`,
      `  node apps/cli-tool/index.js db:init`,
      `docker compose up -d ingestion-worker nlp-worker`,
      ``,
      `# Helper: archive processed inbox files so a later burst won't re-ingest them.`,
      `archive_inbox() {`,
      `  for f in "$LOCAL_FILES_DIR"/*.xlsx; do`,
      `    [ -e "$f" ] || continue`,
      `    n=$(basename "$f")`,
      `    aws s3 mv "$INBOX/$n" "$INBOX/processed/$RELEASE/$n" --region $REGION || true`,
      `  done`,
      `}`,
      ``,
      `# ----- Ingest the inbox files (LOCAL mode: no DOL scrape) -----`,
      `# Scope covers FLAG (LCA_Disclosure_Data_FY…) AND pre-FLAG (H-1B_Disclosure_`,
      `# Data_FY…) names; floor 2018. Pre-FLAG files only reach the inbox on a`,
      `# deliberate historical upload — the daily dol-watch only sends the newest FLAG`,
      `# file — so this widening is harmless for the normal quarterly flow.`,
      `HARVEST_OUT=$(HARVEST_ONCE=1 HARVEST_LOCAL_DIR=$LOCAL_FILES_DIR \\`,
      `  HARVEST_START_YEAR=\${HARVEST_START_YEAR:-2018} \\`,
      `  HARVEST_FILE_PATTERN='(?:LCA|H-1B)_Disclosure_Data_FY(20\\d{2})' \\`,
      `  DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \\`,
      `  REDIS_URL=redis://localhost:6379 \\`,
      `  pnpm --silent --filter harvester harvest:once 2>&1)`,
      `echo "$HARVEST_OUT"`,
      `SUMMARY_JSON=$(echo "$HARVEST_OUT" | grep -oE 'HARVEST_SUMMARY .*' | tail -1 | sed 's/HARVEST_SUMMARY //' || true)`,
      `ENQUEUED=$(echo "$SUMMARY_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("enqueued",0))' 2>/dev/null || echo 0)`,
      ``,
      `# Inbox files were all already processed (nothing new) — archive + exit.`,
      `if [ "\${ENQUEUED:-0}" = "0" ]; then`,
      `  archive_inbox`,
      `  aws sns publish --region $REGION --topic-arn ${notifyTopic.topicArn} \\`,
      `    --subject "[LCA] inbox had no new LCA data ($RELEASE)" \\`,
      `    --message "Inbox files were already processed. Summary: \${SUMMARY_JSON:-none}. Terminating."`,
      `  aws ec2 terminate-instances --region $REGION --instance-ids $INSTANCE_ID`,
      `  exit 0`,
      `fi`,
      ``,
      `# Deferred NLP? Read the DeferNlp tag the launcher stamped (per-run). Deferred`,
      `# = wait only for the INGEST queue at the barrier; the NLP worker keeps draining`,
      `# nlp-tasks in the BACKGROUND on this kept-alive review box, and a later`,
      `# Rebuild-preview picks up the normalised data. Full (default) = wait for both.`,
      `DEFER_NLP=$(aws ec2 describe-tags --region $REGION \\`,
      `  --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=DeferNlp" \\`,
      `  --query 'Tags[0].Value' --output text 2>/dev/null || echo false)`,
      `[ "$DEFER_NLP" = "None" ] && DEFER_NLP=false`,
      `if [ "$DEFER_NLP" = "true" ]; then BARRIER_QUEUES="ingest-tasks"; else BARRIER_QUEUES="ingest-tasks nlp-tasks"; fi`,
      `echo "defer NLP: $DEFER_NLP — barrier waits on: $BARRIER_QUEUES"`,
      ``,
      `# Barrier: wait for the relevant queue(s) to drain (two consecutive empty checks`,
      `# guard against a momentary lull mid-batch). qdepth.mjs MUST live in a workspace`,
      `# package dir so its bullmq/ioredis imports resolve — running it from /tmp made`,
      `# the import fail, and the old '|| echo 1' then looped the barrier forever.`,
      `QDEPTH=/opt/lca/apps/harvester/qdepth.mjs`,
      `cat > "$QDEPTH" <<'MJS'`,
      `import { Queue } from 'bullmq';`,
      `import IORedis from 'ioredis';`,
      `const r = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });`,
      `let total = 0;`,
      `for (const n of process.argv.slice(2)) {`,
      `  const q = new Queue(n, { connection: r });`,
      `  const c = await q.getJobCounts('waiting','active','delayed','paused');`,
      `  total += (c.waiting||0)+(c.active||0)+(c.delayed||0)+(c.paused||0);`,
      `  await q.close();`,
      `}`,
      `console.log(total);`,
      `await r.quit();`,
      `MJS`,
      `# Sanity: the helper must actually run, else the barrier would loop forever.`,
      `if ! node "$QDEPTH" $BARRIER_QUEUES >/dev/null 2>&1; then`,
      `  aws sns publish --region $REGION --topic-arn ${notifyTopic.topicArn} \\`,
      `    --subject "[LCA] burst barrier helper failed ($RELEASE)" \\`,
      `    --message "qdepth.mjs could not run (dependency resolution?). Box stays up for debugging."`,
      `  exit 1`,
      `fi`,
      `EMPTY=0`,
      `while [ "$EMPTY" -lt 2 ]; do`,
      `  sleep 20`,
      `  DEPTH=$(node "$QDEPTH" $BARRIER_QUEUES 2>/dev/null || echo ERR)`,
      `  if [ "$DEPTH" = "0" ]; then EMPTY=$((EMPTY+1)); else EMPTY=0; fi`,
      `done`,
      `echo "barrier drained ($BARRIER_QUEUES) for $RELEASE"`,
      ``,
      `# Ingested into PG — archive the inbox files out of the way.`,
      `archive_inbox`,
      ``,
      `# Refresh the analytics matviews from the freshly normalised PG.`,
      `pnpm --filter @lca/cli analytics:refresh-views`,
      ``,
      `# Build the SQLite snapshot + summaries from the (freshly normalised) PG.`,
      `pnpm --filter analytics-web build:sqlite`,
      `LLM_API_KEY=$(aws secretsmanager get-secret-value \\`,
      `  --secret-id ${shared.llmApiKeySecret.secretName} --query SecretString --output text) \\`,
      `LLM_PROVIDER=anthropic \\`,
      `  pnpm --filter analytics-web build:summaries`,
      ``,
      `# Upload the CANDIDATE lca.db (a staging key) — NEVER the prod key.`,
      `# The prod key (lca.db) is only written by the Promote step, so a review`,
      `# cycle can never clobber live prod data.`,
      `aws s3 cp apps/analytics-web/data/lca.db \\`,
      `  s3://${shared.lcaDbBucket.bucketName}/candidates/$RELEASE/lca.db`,
      ``,
      `# Build + push the Lambda image (native arm64 — this is a Graviton box,`,
      `# matching the arm64 serving Lambda).`,
      `ECR_URI=$(aws ecr describe-repositories --repository-names ${shared.lambdaImageRepo.repositoryName} \\`,
      `  --query 'repositories[0].repositoryUri' --output text)`,
      `aws ecr get-login-password --region $REGION | \\`,
      `  docker login --username AWS --password-stdin "$ECR_URI"`,
      `docker build -f apps/analytics-web/Dockerfile.lambda -t "$ECR_URI:latest" .`,
      `docker push "$ECR_URI:latest"`,
      ``,
      `# Point the DEV serving Lambda at the candidate image → dev.h1b.report`,
      `# preview. Prod is untouched until Promote.`,
      `aws lambda update-function-code \\`,
      `  --function-name lca-analytics-web \\`,
      `  --image-uri "$ECR_URI:latest"`,
      `aws lambda wait function-updated --function-name lca-analytics-web || true`,
      `DEV_DIST=$(aws cloudformation describe-stacks --stack-name LcaServeStack \\`,
      `  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text 2>/dev/null || true)`,
      `if [ -n "$DEV_DIST" ] && [ "$DEV_DIST" != "None" ]; then`,
      `  aws cloudfront create-invalidation --distribution-id "$DEV_DIST" --paths '/*' || true`,
      `fi`,
      ``,
      `# Snapshot Postgres back to S3 (so the next run restores fast).`,
      `docker compose exec -T db pg_dump --format=custom -U lca_user -d lca_db \\`,
      `  > /tmp/latest.pgdump`,
      `aws s3 cp /tmp/latest.pgdump s3://${shared.pgSnapshotBucket.bucketName}/latest.pgdump`,
      ``,
      `# ----- Bring up the operator review UI against the local Postgres -----`,
      `export OPERATOR_PASSWORD=$(aws secretsmanager get-secret-value \\`,
      `  --secret-id ${shared.operatorPasswordSecret.secretName} --query SecretString --output text)`,
      `export SESSION_SECRET=$(aws secretsmanager get-secret-value \\`,
      `  --secret-id ${shared.sessionSecret.secretName} --query SecretString --output text)`,
      `export INSTANCE_ID AWS_REGION=$REGION RELEASE`,
      `docker compose up -d operator-ui`,
      `unset OPERATOR_PASSWORD SESSION_SECRET`,
      ``,
      `# ----- TLS + DNS for operator.h1b.report (Caddy + Let's Encrypt DNS-01) -----`,
      `CF_TOKEN=$(aws secretsmanager get-secret-value \\`,
      `  --secret-id ${shared.cloudflareTokenSecret.secretName} --query SecretString --output text)`,
      `PUBLIC_IP=$(imds public-ipv4)`,
      `# Caddy binary with the Cloudflare DNS module baked in (arm64).`,
      `curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=arm64&p=github.com/caddy-dns/cloudflare" \\`,
      `  -o /usr/local/bin/caddy && chmod +x /usr/local/bin/caddy`,
      `mkdir -p /etc/caddy`,
      `cat > /etc/caddy/Caddyfile <<'CADDY'`,
      `operator.h1b.report {`,
      `  reverse_proxy localhost:8080`,
      `  tls {`,
      `    dns cloudflare {env.CLOUDFLARE_API_TOKEN}`,
      `  }`,
      `}`,
      `CADDY`,
      `CLOUDFLARE_API_TOKEN=$CF_TOKEN /usr/local/bin/caddy start --config /etc/caddy/Caddyfile --adapter caddyfile`,
      ``,
      `# Upsert the operator.h1b.report A-record → this instance's public IP.`,
      `ZONE_ID=$(curl -sf -H "Authorization: Bearer $CF_TOKEN" \\`,
      `  "https://api.cloudflare.com/client/v4/zones?name=h1b.report" \\`,
      `  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"][0]["id"])')`,
      `REC_ID=$(curl -sf -H "Authorization: Bearer $CF_TOKEN" \\`,
      `  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?type=A&name=operator.h1b.report" \\`,
      `  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r[0]["id"] if r else "")')`,
      `REC_BODY="{\\"type\\":\\"A\\",\\"name\\":\\"operator.h1b.report\\",\\"content\\":\\"$PUBLIC_IP\\",\\"ttl\\":120,\\"proxied\\":false}"`,
      `if [ -n "$REC_ID" ]; then`,
      `  curl -sf -X PUT -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \\`,
      `    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$REC_ID" -d "$REC_BODY"`,
      `else`,
      `  curl -sf -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \\`,
      `    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" -d "$REC_BODY"`,
      `fi`,
      `unset CF_TOKEN CLOUDFLARE_API_TOKEN`,
      ``,
      `# ----- Notify: ready for review. The box stays UP (no self-terminate) -----`,
      `# Teardown happens on operator command (Shut down button → Teardown Step Fn).`,
      `aws sns publish --topic-arn ${notifyTopic.topicArn} \\`,
      `  --subject "[LCA] review environment ready ($RELEASE)" \\`,
      `  --message "Release $RELEASE is built and ready for human review.`,
      ``,
      `  Ingest summary: \${SUMMARY_JSON:-n/a}`,
      ``,
      `  Operator UI : https://operator.h1b.report`,
      `  Preview site: https://dev.h1b.report`,
      ``,
      `  Log in, walk the Reviews / Quarantine / Unresolved queues, then either`,
      `  click Promote (ship to prod) or Shut down (terminate this box)."`,
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'BurstLaunchTemplate', {
      launchTemplateName: 'lca-burst',
      // Graviton (arm64) so a plain `docker build` produces an arm64 image that
      // matches the arm64 serving Lambda — no QEMU cross-build needed. Also
      // cheaper than the equivalent Intel box.
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      // Default size; the Step Function (PrepareConfig) overrides InstanceType
      // per-run from the trigger event — c7g.2xlarge for the regular harvester +
      // quarterly path, a bigger box for a historical backfill.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.C7G, ec2.InstanceSize.XLARGE2),
      role: ec2Role,
      securityGroup: sg,
      userData,
      // IMDSv2 required; hop limit 2 so the operator-ui CONTAINER can reach the
      // instance metadata service and assume the instance role (to PutEvents).
      requireImdsv2: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(100, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
          encrypted: true,
        }),
      }],
    });
    // requireImdsv2 sets HttpTokens=required but leaves the hop limit at 1,
    // which blocks Docker containers from IMDS. Bump it to 2 via the L1.
    (launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate).addPropertyOverride(
      'LaunchTemplateData.MetadataOptions.HttpPutResponseHopLimit', 2,
    );

    // NOTE: the DOL-checker Lambda + daily schedule were REMOVED — DOL's WAF
    // blocks AWS IP ranges (403 to Lambda + EC2), so no AWS-resident checker can
    // see new releases. Detection now runs OFF-AWS via the dol-watch agent
    // (infra/mac), which uploads the new file to the S3 inbox and fires the
    // ManualRunRule (lca.manual / build.run) below. See infra/mac/README.md.

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
        // Per-run instance size from the trigger event (default c7g.2xlarge). A
        // historical backfill passes a bigger one; quarterly runs use the default.
        'InstanceType.$': '$.prep.cfg.instanceType',
        TagSpecifications: [{
          ResourceType: 'instance',
          // BurstWorker drives the IAM self-terminate condition + single-flight.
          // DeferNlp (per-run) tells the box to wait only for ingest at the barrier.
          Tags: [
            { Key: 'BurstWorker', Value: 'true' },
            { Key: 'Name',        Value: 'lca-burst-worker' },
            { Key: 'DeferNlp', 'Value.$': '$.prep.cfg.deferNlp' },
          ],
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

    // Single-flight guard: don't launch a 2nd c7g if a review box is already up
    // (the daily dol-checker could otherwise start a second instance mid-review).
    const checkRunning = new tasks.CallAwsService(this, 'CheckBurstRunning', {
      service: 'ec2',
      action: 'describeInstances',
      iamResources: ['*'],
      parameters: {
        Filters: [
          { Name: 'tag:BurstWorker', Values: ['true'] },
          { Name: 'instance-state-name', Values: ['pending', 'running'] },
        ],
      },
      resultPath: '$.running',
    });
    const skip = new tasks.SnsPublish(this, 'NotifyAlreadyRunning', {
      topic: notifyTopic,
      subject: '[LCA] burst already running — skipping',
      message: sfn.TaskInput.fromText(
        'A review box is already up; skipping this trigger to avoid a second instance.',
      ),
    });

    // Merge per-run overrides from the trigger event over safe defaults, so a
    // single trigger can request a bigger box and/or deferred NLP:
    //   instanceType — default c7g.2xlarge (regular: harvester + quarterly).
    //   deferNlp     — default 'false' (full NLP barrier). 'true' = ingest-only.
    // $.detail always exists (EventBridge passes the full event); JsonMerge lets
    // the event's fields win and fills any it omits.
    const prepConfig = new sfn.Pass(this, 'PrepareConfig', {
      parameters: {
        'cfg.$': "States.JsonMerge(States.StringToJson('{\"instanceType\":\"c7g.2xlarge\",\"deferNlp\":\"false\"}'), $.detail, false)",
      },
      resultPath: '$.prep',
    });

    const definition = prepConfig.next(checkRunning.next(
      new sfn.Choice(this, 'AlreadyRunning?')
        .when(
          sfn.Condition.isPresent('$.running.Reservations[0].Instances[0].InstanceId'),
          skip,
        )
        .otherwise(runEc2.addCatch(failure, { resultPath: '$.error' }).next(success)),
    ));

    const stateMachine = new sfn.StateMachine(this, 'BuildPipeline', {
      stateMachineName: 'lca-build-pipeline',
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(4),
      logs: {
        destination: new logs.LogGroup(this, 'BuildPipelineLogs', {
          logGroupName: '/lca/burst/stepfunctions',
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        // ALL gives state-by-state transition records; useful for the
        // first few months of operation. Bump to ERROR-only later if
        // CloudWatch ingest cost becomes a concern (it won't at this scale).
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });

    // CallAwsService('ec2','runInstances') auto-grants ec2:RunInstances but NOT
    // iam:PassRole, which RunInstances requires to attach the burst instance
    // profile. Without it the task fails "You are not authorized to perform this
    // operation". Grant PassRole on the burst EC2 role (+ CreateTags for the
    // launch-time TagSpecifications).
    stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [ec2Role.roleArn],
    }));
    stateMachine.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags'],
      resources: ['*'],
    }));

    // The burst is triggered by the off-AWS dol-watch agent (it uploads a new
    // file to the S3 inbox, then fires this event). The single-flight guard in
    // the state machine prevents a second box if one is already up.
    new events.Rule(this, 'ManualRunRule', {
      eventPattern: {
        source: ['lca.manual'],
        detailType: ['build.run'],
      },
      targets: [new targets.SfnStateMachine(stateMachine)],
    });

    // ---------------------------------------------------------------------
    // Operator-driven release control. The operator UI (running on the burst
    // box) publishes EventBridge events; these two state machines react.
    // The UI itself holds NO prod-deploy IAM — it can only PutEvents. The
    // actual prod deploy runs on the EC2 (where the corrected Postgres lives)
    // via SSM RunCommand.
    //
    //   lca.operator / promote.run  → PromotePipeline → ssm:SendCommand(ec2-promote.sh)
    //   lca.operator / teardown.run → TeardownPipeline → ssm:SendCommand(ec2-teardown.sh)
    //
    // SendCommand returns once the command is queued; the on-box scripts
    // publish the authoritative "promoted" / "torn down" SNS message.
    // ---------------------------------------------------------------------
    const sendCommand = (id: string, scriptPath: string) =>
      new tasks.CallAwsService(this, id, {
        service: 'ssm',
        action: 'sendCommand',
        iamResources: ['*'],
        parameters: {
          DocumentName: 'AWS-RunShellScript',
          InstanceIds: sfn.JsonPath.array(sfn.JsonPath.stringAt('$.detail.instanceId')),
          Parameters: {
            commands: [
              'set -euxo pipefail',
              'cd /opt/lca',
              // IMDSv2 token (HttpTokens=required) — a plain IMDSv1 GET 401s.
              'IMT=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 600")',
              'REGION=$(curl -sf -H "X-aws-ec2-metadata-token: $IMT" http://169.254.169.254/latest/meta-data/placement/region)',
              `AWS_REGION=$REGION bash ${scriptPath}`,
            ],
          },
          CloudWatchOutputConfig: { CloudWatchOutputEnabled: true },
        },
        resultPath: '$.command',
      });

    const promoteFail = new tasks.SnsPublish(this, 'PromoteDispatchFail', {
      topic: notifyTopic,
      subject: '[LCA] promote FAILED to dispatch',
      message: sfn.TaskInput.fromJsonPathAt('$'),
    });
    const promoteOk = new tasks.SnsPublish(this, 'PromoteDispatched', {
      topic: notifyTopic,
      subject: '[LCA] promote dispatched',
      message: sfn.TaskInput.fromText(
        'Promote-to-prod started on the review box. It will publish the result when done.',
      ),
    });
    const promotePipeline = new sfn.StateMachine(this, 'PromotePipeline', {
      stateMachineName: 'lca-promote-pipeline',
      definitionBody: sfn.DefinitionBody.fromChainable(
        sendCommand('PromoteSendCommand', 'infra/aws/scripts/ec2-promote.sh')
          .addCatch(promoteFail, { resultPath: '$.error' })
          .next(promoteOk),
      ),
      timeout: Duration.hours(1),
    });

    const teardownFail = new tasks.SnsPublish(this, 'TeardownDispatchFail', {
      topic: notifyTopic,
      subject: '[LCA] teardown FAILED to dispatch',
      message: sfn.TaskInput.fromJsonPathAt('$'),
    });
    const teardownOk = new tasks.SnsPublish(this, 'TeardownDispatched', {
      topic: notifyTopic,
      subject: '[LCA] teardown dispatched',
      message: sfn.TaskInput.fromText(
        'Teardown started: the review box will remove its DNS record and self-terminate.',
      ),
    });
    const teardownPipeline = new sfn.StateMachine(this, 'TeardownPipeline', {
      stateMachineName: 'lca-teardown-pipeline',
      definitionBody: sfn.DefinitionBody.fromChainable(
        sendCommand('TeardownSendCommand', 'infra/aws/scripts/ec2-teardown.sh')
          .addCatch(teardownFail, { resultPath: '$.error' })
          .next(teardownOk),
      ),
      timeout: Duration.minutes(15),
    });

    const previewFail = new tasks.SnsPublish(this, 'PreviewDispatchFail', {
      topic: notifyTopic,
      subject: '[LCA] preview rebuild FAILED to dispatch',
      message: sfn.TaskInput.fromJsonPathAt('$'),
    });
    const previewOk = new tasks.SnsPublish(this, 'PreviewDispatched', {
      topic: notifyTopic,
      subject: '[LCA] preview rebuild dispatched',
      message: sfn.TaskInput.fromText(
        'Rebuilding dev.h1b.report from the edited Postgres; it will publish when ready.',
      ),
    });
    const previewPipeline = new sfn.StateMachine(this, 'RebuildPreviewPipeline', {
      stateMachineName: 'lca-rebuild-preview-pipeline',
      definitionBody: sfn.DefinitionBody.fromChainable(
        sendCommand('PreviewSendCommand', 'infra/aws/scripts/ec2-rebuild-preview.sh')
          .addCatch(previewFail, { resultPath: '$.error' })
          .next(previewOk),
      ),
      timeout: Duration.hours(1),
    });

    new events.Rule(this, 'PromoteRule', {
      eventPattern: { source: ['lca.operator'], detailType: ['promote.run'] },
      targets: [new targets.SfnStateMachine(promotePipeline)],
    });
    new events.Rule(this, 'TeardownRule', {
      eventPattern: { source: ['lca.operator'], detailType: ['teardown.run'] },
      targets: [new targets.SfnStateMachine(teardownPipeline)],
    });
    new events.Rule(this, 'RebuildPreviewRule', {
      eventPattern: { source: ['lca.operator'], detailType: ['preview.run'] },
      targets: [new targets.SfnStateMachine(previewPipeline)],
    });
  }
}
