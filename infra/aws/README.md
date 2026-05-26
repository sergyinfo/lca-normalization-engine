# AWS-native deployment (CDK)

This directory holds the CDK templates that deploy the analytics web app
and its data pipeline to AWS. Four independent stacks, deployed in order:

1. **`LcaSharedStack`** — S3 buckets, Secrets Manager entries, ECR repo
2. **`LcaDataPipelineStack`** — burst data ops (EventBridge → Step Fn → EC2)
3. **`LcaServeStack`** — CloudFront + Lambda Container Image + S3 static
4. **`LcaBudgetsStack`** — five AWS Budgets + Cost Anomaly Detection + SNS (env-tunable; deploy 24 h after cost-allocation tags activate so tag-filtered budgets don't silently report $0)

Together they implement the architecture sketched in [`../../DEPLOY.md`](../../DEPLOY.md#52-vps--cloudflare-cdn-recommended-once-traffic-ramps) but on AWS-native primitives, with scale-to-zero on the data side.

---

## Architecture

```
            ┌── Burst (idle 99% of the year) ──────────────────────┐
            │                                                       │
            │   EventBridge ─► Lambda (DOL ETag check, every 6h)    │
            │                       │                               │
            │                       ▼ on change                     │
            │              Step Functions state machine             │
            │                       │                               │
            │                       ▼                               │
            │              EC2 c6i.2xlarge (5–8h)                   │
            │              ├── Postgres + ingestor                  │
            │              ├── build:sqlite → lca.db                │
            │              ├── build:summaries (Anthropic API)      │
            │              ├── push to ECR + update Lambda          │
            │              └── self-terminate                       │
            │                                                       │
            │   Artefacts → S3 (versioned)  ←──────────────────────┐│
            └───────────────────────────────────────────────────────┘│
                                                                     │
            ┌── Serve (always-on, mostly idle) ────────────────────┐ │
            │                                                       │ │
            │   Internet ─► CloudFront ─► Lambda Container ◄────────┘
            │                       │   (Next.js standalone via      │
            │                       │    AWS Lambda Web Adapter)     │
            │                       │                                │
            │                       └─► S3 (static HTML, JS, CSS)    │
            │                                                        │
            └────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- AWS account with admin access for the deploy user
- AWS CDK v2 installed: `npm install -g aws-cdk`
- A bootstrapped CDK env: `cdk bootstrap aws://ACCOUNT/REGION`
- Docker (the burst EC2 uses Amazon Linux 2023; image builds happen there)
- `pnpm install` inside this directory once

```bash
cd infra/aws
pnpm install
```

---

## First-time migration from a local environment

If you've already ingested data locally and just want to host on AWS
**without re-running the expensive ingest pipeline**, the flow is:

1. Validate the CDK templates without spending money:
   ```bash
   pnpm install
   pnpm synth
   ```
2. Bootstrap CDK in your target account/region (one-time):
   ```bash
   export CDK_DEFAULT_REGION=us-east-1
   npx cdk bootstrap
   ```
3. Deploy the Shared stack only (creates empty buckets + ECR, no compute):
   ```bash
   pnpm deploy:shared
   aws secretsmanager put-secret-value --secret-id lca/llm-api-key --secret-string "sk-..."
   ```
4. **Run the migration script** — uploads your local lca.db, builds + pushes the
   Lambda image, dumps + uploads your local Postgres database:
   ```bash
   ./scripts/migrate-from-local.sh
   ```
5. Deploy the rest:
   ```bash
   pnpm deploy:serve   # ~15 min for CloudFront
   pnpm deploy:data    # provisions burst pipeline, sits idle
   ```
6. Smoke-test the live CloudFront URL:
   ```bash
   CF_DOMAIN=$(aws cloudfront list-distributions \
     --query 'DistributionList.Items[?Comment==`LCA analytics web — CloudFront distribution`].DomainName' \
     --output text)
   ../../scripts/smoke-test.sh "https://$CF_DOMAIN"
   ```
7. Activate cost-allocation tags, wait 24h, then deploy budgets (see §Tagging + §Billing).

**No quarterly rebuild runs in step 5** — the data pipeline stack just
sits idle until DOL publishes a new release. Your serving site uses the
pre-built lca.db you uploaded in step 4.

The Postgres dump on S3 lets future burst runs do *incremental* updates
(restore dump → ingest new quarter → re-export) instead of bootstrapping
from raw DOL XLSX files.

---

## One-time setup

```bash
# 1. Pick a region (or rely on AWS_REGION env var)
export CDK_DEFAULT_REGION=us-east-1

# 2. Bootstrap CDK in that region (idempotent)
cdk bootstrap

# 3. Deploy the shared stack first — it owns the S3 buckets, ECR repo
#    and Secrets Manager entries the others depend on.
pnpm deploy:shared

# 4. After the shared stack is up, populate the LLM API key secret:
aws secretsmanager put-secret-value \
  --secret-id lca/llm-api-key \
  --secret-string "sk-ant-xxxxxxxxxxxxxxxxxxx"

# 5. Deploy the data pipeline. This wires EventBridge → Lambda checker → Step Fn → EC2.
pnpm deploy:data

# 6. Build + push the first Lambda container image *before* deploying the serve stack
#    (or the serve stack will fail to resolve `:latest`).
#    See "Bootstrap the first image" below.

# 7. Deploy the serve stack.
pnpm deploy:serve
```

### Bootstrap the first image

The serve stack references `:latest` in the ECR repo. Until the burst
pipeline has run once, that tag doesn't exist. Do an initial manual push
from your dev machine:

```bash
# Get ECR push login
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=$CDK_DEFAULT_REGION
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

# Build + push (from the repo root, not infra/aws)
cd ../..
docker build -f apps/analytics-web/Dockerfile.lambda \
  -t "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/lca-analytics-web:latest" .
docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/lca-analytics-web:latest"

# Now deploy the serve stack
cd infra/aws
pnpm deploy:serve
```

Subsequent rebuilds happen automatically inside the burst EC2 instance.

---

## What each stack creates

### `LcaSharedStack`

| Resource | Purpose |
|---|---|
| `LcaDbBucket` (S3, versioned) | Holds the canonical `lca.db` artefact + version history |
| `PgSnapshotBucket` (S3) | Postgres dumps between quarterly runs |
| `IngestScratchBucket` (S3) | Raw DOL XLSX downloads (30-day TTL) |
| `LambdaImageRepo` (ECR) | Holds the Next.js Lambda container images |
| `LlmApiKeySecret` (Secrets Manager) | Anthropic / OpenAI key (you populate post-deploy) |
| `PgPasswordSecret` (Secrets Manager) | Auto-generated PG password for burst EC2 |

### `LcaDataPipelineStack`

| Resource | Purpose |
|---|---|
| `BurstVpc` (VPC, 1 AZ, 0 NAT, S3 gateway endpoint) | Network for the EC2 instance |
| `BurstLaunchTemplate` (EC2) | c6i.2xlarge with cloud-init that runs the pipeline + self-terminates |
| `DolChecker` (Lambda, Node 22) | Compares DOL page fingerprint vs SSM-stored value |
| `LastDolEtag` (SSM Parameter) | Persistence for the checker |
| `BuildPipeline` (Step Functions) | Orchestrates EC2 launch + notifications |
| `DolCheckSchedule` (EventBridge) | Triggers checker every 6 hours |
| `ManualRunRule` (EventBridge) | Lets ops trigger a build via `aws events put-events` |
| `BuildNotifications` (SNS) | Subscribe ops emails / Slack webhook out-of-band |

### `LcaServeStack`

| Resource | Purpose |
|---|---|
| `AnalyticsWebFn` (Lambda DockerImage) | Runs Next.js standalone + LWA, 512 MB / ARM64 |
| `StaticAssetsBucket` (S3) | Pre-rendered HTML, JS, CSS uploaded by the burst pipeline |
| `Distribution` (CloudFront) | Routes /_next/static/* + /sitemap.xml to S3, everything else to Lambda |
| `SecurityHeaders` (CF Response Headers Policy) | HSTS, X-Frame-Options, Referrer-Policy, etc. |

---

## Triggering a build manually

```bash
aws events put-events --entries '[{
  "Source": "lca.manual",
  "DetailType": "build.run",
  "Detail": "{}"
}]'

# Or directly invoke the state machine
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:REGION:ACCOUNT:stateMachine:lca-build-pipeline \
  --name "manual-$(date +%s)"
```

Watch progress in the AWS console (Step Functions → State machines → lca-build-pipeline) or via SNS notifications.

---

## Subscribing to build notifications

```bash
aws sns subscribe \
  --topic-arn $(aws sns list-topics --query 'Topics[?contains(TopicArn,`BuildNotifications`)].TopicArn' --output text) \
  --protocol email \
  --notification-endpoint you@example.com
```

You'll get an email per build with launch + completion status.

---

## Cost estimate

Conservative numbers for 300k visits/month + 4 builds/year:

| Service | Monthly | Annual |
|---|---|---|
| CloudFront (after free tier) | $0–3 | $0–36 |
| Lambda invocations | $1–2 | $12–24 |
| S3 (static + lca.db + snapshots) | $0.50 | $6 |
| ECR (Lambda image storage) | $0.10 | $1.20 |
| Secrets Manager (2 secrets) | $0.80 | $10 |
| Burst EC2 (8h × 4 quarters) | — | ~$11 |
| Step Functions | — | <$1 |
| Anthropic API (build:summaries) | — | ~$4 |
| Route 53 (if used) | $0.50 | $6 |
| **Total** | **~$3–6/mo** | **~$60–90/yr** |

First-year cost is lower thanks to the CloudFront free tier (1 TB/mo) and Lambda free tier.

---

## Billing alerts & budgets

The `LcaBudgetsStack` ships **five budgets** plus **Cost Anomaly Detection**
so a misconfigured loop or a runaway burst run can't quietly drain your
account overnight.

### What's protected

| Budget | Default cap | Time unit | Filter | Notes |
|---|---|---|---|---|
| `lca-monthly-total` | **$20** | MONTHLY | `Project=h1b-report` | Catches the obvious "what happened?" case across the whole project |
| `lca-monthly-serve` | $10 | MONTHLY | `Project + Component=serve` | CloudFront + Lambda + S3 — should sit at ~$3–6 |
| `lca-monthly-data-pipeline` | $10 | MONTHLY | `Project + Component=data-pipeline` | Burst EC2 + Step Fn — should be $0 in months without a build |
| `lca-quarterly-burst` | $50 | QUARTERLY | `Project + Component=data-pipeline` | One full build run should cost <$5; this catches a 10× anomaly |
| `lca-annual-cap` | $150 | ANNUALLY | `Project=h1b-report` | Sanity ceiling for the whole project, full year |

Each monthly/quarterly budget alerts at **50% / 80% / 100% of actual** plus
**100% forecasted** (AWS projects month-end based on current trajectory and
alerts early if the trajectory exceeds the cap). The annual cap uses a
quieter ladder: 80% / 100% actual + 100% forecasted only.

### Cost Anomaly Detection (free)

On top of the fixed budgets, a CloudWatch-Cost-Explorer-side ML monitor
watches for **spikes that don't trip a fixed threshold**. Example: your
daily cost drifts from $0.50 to $5/day. That's a 10× jump but still under
$20/month for half the month — the budget wouldn't fire. The anomaly
monitor catches it within 24 hours.

Configured threshold: **alert when an anomaly's total impact ≥ $5**. Tunable
via `LCA_ANOMALY_THRESHOLD_USD`.

### Where alerts go

All alerts route through a dedicated **SNS topic** (`BillingAlertsTopic`,
separate from build notifications) and to the email address set via
`LCA_BILLING_EMAIL`. You can fan-out later by subscribing Slack, PagerDuty,
or anything else to the SNS topic without touching the budgets themselves.

```bash
# Subscribe an email to the SNS topic (in addition to the direct budget email)
aws sns subscribe \
  --topic-arn $(aws sns list-topics \
    --query 'Topics[?contains(TopicArn,`BillingAlertsTopic`)].TopicArn' --output text) \
  --protocol email \
  --notification-endpoint billing-ops@example.com

# Subscribe a Slack webhook (via API Gateway → Lambda → Slack, or third-party)
aws sns subscribe \
  --topic-arn ... --protocol https --notification-endpoint https://hooks.slack.com/...
```

### Deploying

```bash
# Set the alert email before deploying
export LCA_BILLING_EMAIL='you@example.com'

# (Optional) override default thresholds
export LCA_MONTHLY_BUDGET_USD=30
export LCA_BURST_BUDGET_USD=80

pnpm deploy:budgets
```

AWS sends a confirmation email to the address; click the "Confirm subscription" link before the first alert fires.

### Prerequisite: activate cost-allocation tags

Tag-filtered budgets (everything except a hypothetical "all-AWS" budget)
need the underlying tags to be **activated as cost-allocation tags** in
the Billing Console first. Until you do this, the tag filters return
empty and the budget reports $0 — which silently disables them.

```bash
aws ce update-cost-allocation-tags-status --cost-allocation-tags-status \
  '[{"TagKey":"Project","Status":"Active"},
    {"TagKey":"Component","Status":"Active"},
    {"TagKey":"Environment","Status":"Active"}]'
```

This takes 24 hours to propagate. Plan to deploy the budgets stack **after**
the Shared/Data/Serve stacks have been deployed AND tags have been active
for 24+ hours — otherwise the budgets will fire at 0% for a day.

### Tuning the thresholds

All thresholds are env-var driven so you don't have to edit code:

| Env var | Default | What it caps |
|---|---|---|
| `LCA_MONTHLY_BUDGET_USD` | 20 | Whole project, per month |
| `LCA_COMPONENT_BUDGET_USD` | 10 | Each of serve + data-pipeline, per month |
| `LCA_BURST_BUDGET_USD` | 50 | Whole quarter of data-pipeline activity |
| `LCA_ANNUAL_BUDGET_USD` | 150 | Whole project, full calendar year |
| `LCA_ANOMALY_THRESHOLD_USD` | 5 | Anomaly Detection minimum dollar impact |
| `LCA_BILLING_EMAIL` | _(none)_ | Recipient for direct + SNS-routed alerts |

Set them inline:

```bash
LCA_MONTHLY_BUDGET_USD=50 LCA_BILLING_EMAIL=ops@example.com pnpm deploy:budgets
```

Or persist them in your shell profile / CI environment.

### Going further: budget actions (not enabled by default)

AWS Budgets supports **automatic actions** when a threshold trips: stop EC2
instances, detach an IAM policy, etc. This is intentionally NOT enabled
here because:

- A misconfigured threshold could shut down your live website
- For a thesis project, alert-first is the right default
- Easy to add later via `CfnBudget.budget.actionsArn`

If you want to add e.g. "stop the burst EC2 if monthly data-pipeline cost
exceeds $30", that's ~20 lines added to `budgets-stack.ts`.

### Verifying alerts work

```bash
# Confirm SNS topic exists with the right subscriptions
aws sns list-subscriptions \
  --query 'Subscriptions[?contains(TopicArn,`BillingAlertsTopic`)]'

# List all budgets in the account (CDK-created + any pre-existing)
aws budgets describe-budgets --account-id $(aws sts get-caller-identity --query Account --output text)

# Force-test the anomaly monitor (no AWS API for "fire a test alert" —
# easiest is to wait for a real anomaly, or temporarily lower the
# threshold to $0.01 and trigger one)
```

## Tagging

Every taggable resource in every stack gets a consistent set of tags
applied via CDK tag propagation. This unlocks:

- Cost Explorer grouping by project / component / environment
- Resource Groups for "show me everything in this project"
- IAM conditions that reference tags (e.g. the burst EC2's
  `TerminateInstances` permission is scoped to `BurstWorker=true`)

### The canonical tag set

| Tag | Set at | Example values | Why |
|---|---|---|---|
| `Project` | App level (`bin/app.ts`) | `h1b-report` | Top-level project identifier; the one to use in Cost Explorer |
| `ManagedBy` | App level | `cdk` | Distinguish from Terraform / hand-built resources in mixed accounts |
| `Repository` | App level | `lca-normalization-engine` | Trace any resource back to source |
| `Environment` | App level | `prod` / `staging` / `dev` | Read from `LCA_ENVIRONMENT` env var at synth time |
| `Component` | Each stack | `shared` / `data-pipeline` / `serve` | Sub-system filtering inside the project |
| `BurstWorker` | Burst EC2 only | `true` | Used by the IAM `TerminateInstances` condition; intentionally a separate key from `Project` so it can't be satisfied accidentally |
| `Name` | Burst EC2 only | `lca-burst-worker` | Surface a friendly name in the EC2 console |

### What gets tagged automatically

`Tags.of(scope).add(...)` propagates through the entire construct tree, so
**every taggable resource** in the named scope receives the tag — without
having to remember to tag each construct individually. That includes:

- S3 buckets, ECR repositories, Secrets Manager secrets, SSM parameters
- Lambda functions + their log groups
- EC2 launch templates, VPC + subnets + security groups, instances launched from those templates
- Step Functions state machines, EventBridge rules, SNS topics
- CloudFront distributions, IAM roles, CloudWatch log groups

So every resource shows up in Cost Explorer when you group by `Project` or `Component`.

### Activating tags for cost reporting

Tags don't appear in Cost Explorer until you **activate** them as
cost-allocation tags (one-time per AWS account):

```bash
# Activate the project tags for cost reporting
aws ce update-cost-allocation-tags-status --cost-allocation-tags-status \
  '[{"TagKey":"Project","Status":"Active"},
    {"TagKey":"Component","Status":"Active"},
    {"TagKey":"Environment","Status":"Active"},
    {"TagKey":"ManagedBy","Status":"Active"}]'
```

Wait 24 hours; new cost data will be tagged from that point forward. (Historical cost can't be retroactively tagged — only new usage.)

### Common queries

```bash
# Show every resource tagged Project=h1b-report (via Resource Groups)
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=h1b-report \
  --query 'ResourceTagMappingList[].ResourceARN' --output table

# Filter by component
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=h1b-report Key=Component,Values=serve

# Just the burst EC2 (live or recently-terminated within retention window)
aws ec2 describe-instances \
  --filters Name=tag:BurstWorker,Values=true \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,LaunchTime]' \
  --output table
```

### Cost Explorer in the console

1. AWS Console → Billing → Cost Explorer
2. **Group by** → `Tag` → `Project`
3. **Filter** → `Tag` → `Project = h1b-report`
4. (Optional) add a second group: `Component` to split serve / data-pipeline / shared costs
5. Switch the time range to "last 30 days, daily" — the burst-pipeline cost spikes show up clearly on rebuild days

### Overriding for dev / staging

```bash
LCA_ENVIRONMENT=staging pnpm deploy:all
```

Every resource in the staging deployment now has `Environment=staging`, so you can run dev/prod side-by-side in the same account and slice Cost Explorer cleanly.

### Tag governance

If you want to *enforce* tags at deploy time (block resources without
required tags), wrap the App in an `Aspect`:

```typescript
// In bin/app.ts:
import { Aspects } from 'aws-cdk-lib';
import { TagsRequired } from './lib/aspects/tags-required.js';

Aspects.of(app).add(new TagsRequired(['Project', 'Component']));
```

The aspect walks every node at synth time and fails the build if a
required tag is missing. Useful once the project has more than one
contributor. Not included by default — it's a one-line add when you need it.

## Logging

Every component of the stack streams to CloudWatch Logs. Retention is
30 days everywhere, set via CDK (not via the agent's defaults) so
adjusting it is a one-line code change.

| Log group | Source | What's in it |
|---|---|---|
| `/aws/lambda/lca-analytics-web` | Serving Lambda | Every Next.js console.log/error from request handling |
| `/aws/lambda/<DolChecker name>` | DOL checker Lambda | ETag comparisons, Step Fn triggers |
| `/lca/burst/stepfunctions` | Step Functions | Every state transition (level=ALL, includes execution data) |
| `/lca/burst/userdata` | Burst EC2 cloud-init | The pipeline's own stdout — `pnpm build:sqlite`, `docker compose`, `aws s3 cp`, … |
| `/lca/burst/cloud-init` | Burst EC2 system logs | Amazon Linux's own cloud-init logs (boot, package install) |
| `/lca/burst/docker` | Containers on burst EC2 | Postgres, Redis, ingest workers — every container's stdout/stderr via Docker's awslogs driver |

### How it's wired

- **Lambda functions** auto-stream stdout/stderr to their `/aws/lambda/<name>` group; the CDK construct sets retention.
- **Step Functions** writes to its own group via the `logs: { destination, level: ALL }` config on the state machine. `tracingEnabled: true` also turns on X-Ray, which is free at this volume.
- **EC2 burst instance** runs the [CloudWatch Agent](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent.html), installed as the *first* step of cloud-init so all subsequent script output is captured. The agent config is generated inline (see `data-pipeline-stack.ts`) and points at the three pre-created log groups.
- **Docker containers on EC2** use the `awslogs` log driver, configured via `/etc/docker/daemon.json` before any container starts. Every container automatically gets a stream in `/lca/burst/docker` tagged with its name + ID.
- **IAM**: the EC2 instance role has the `CloudWatchAgentServerPolicy` managed policy — that covers both the agent and the Docker awslogs driver.

### Tailing logs from the CLI

```bash
# Serving Lambda — most useful day-to-day
aws logs tail /aws/lambda/lca-analytics-web --follow

# A specific burst run (instance terminated 10 min after run; logs persist)
aws logs tail /lca/burst/userdata --follow --since 1h

# Postgres + ingest container output from a recent run
aws logs tail /lca/burst/docker --follow --since 1h

# Step Functions execution trace
aws logs tail /lca/burst/stepfunctions --follow --since 1h

# DOL checker output — confirm it's actually running on schedule
aws logs tail /aws/lambda/lca-DolChecker --since 1d
```

### Searching across groups (CloudWatch Insights)

```sql
-- Find every burst-EC2 run that failed in the last 7 days
fields @timestamp, @message, @log
| filter @log like /lca\/burst/
| filter @message like /(?i)error|failed|fatal/
| sort @timestamp desc
| limit 100

-- Slow Next.js requests (> 1s)
fields @timestamp, @duration, @message
| filter @log like /lca-analytics-web/
| filter @duration > 1000
| stats count() by bin(5m)
```

### Cost

CloudWatch Logs ingestion is $0.50/GB. The whole pipeline generates well under 100 MB/month at this scale (most of it is per-build burst logs), so steady-state cost is **< $0.10/mo**. Retention at 30 days keeps storage costs negligible too.

### Tuning

| Want | How |
|---|---|
| Longer retention | Change `logs.RetentionDays.ONE_MONTH` in `data-pipeline-stack.ts` to e.g. `THREE_MONTHS` or `ONE_YEAR`; `cdk deploy LcaDataPipelineStack` |
| Less Step Fn noise | Drop `level: sfn.LogLevel.ALL` back to `ERROR` |
| Per-container streams instead of one shared | In `/etc/docker/daemon.json` (cloud-init), change `awslogs-group` to `"awslogs-group": "/lca/burst/{{.Name}}"` |
| Alerts on errors | Add a `MetricFilter` + `Alarm` on each group — see [CloudWatch Logs metric filters](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/MonitoringLogData.html) |

## Operations

| Task | How |
|---|---|
| Force a rebuild | `aws stepfunctions start-execution ...` (above) |
| Roll back to a previous lca.db | Restore previous S3 version, then re-run the EC2 build step to repackage the Lambda image |
| Roll back the Lambda image | `aws lambda update-function-code --function-name lca-analytics-web --image-uri <previous-tag>` |
| Drain CloudFront cache | `aws cloudfront create-invalidation --distribution-id DXXX --paths '/*'` |
| Inspect a build's logs | CloudWatch → log group `/aws/stepfunctions/lca-build-pipeline` + the EC2 instance's `/var/log/burst.log` (via SSM Session Manager) |
| Increase EC2 size for ingestion | Edit `BurstLaunchTemplate` in `data-pipeline-stack.ts` — bump `InstanceClass`/`InstanceSize`, `cdk deploy LcaDataPipelineStack` |

---

## Diff vs. the VPS deployment

| Aspect | Hetzner VPS | This (AWS-native) |
|---|---|---|
| Cold start | None — always warm | ~500ms–1s on first hit after idle |
| Burst data ops | Manual `./scripts/release.sh` | Auto on DOL change |
| Static asset delivery | Cloudflare edge | CloudFront edge (similar perf) |
| TLS | LetsEncrypt | ACM (CloudFront default cert or your own) |
| Cost @ 300k visits/mo | €5/mo flat | ~$3–6/mo + $25/yr burst |
| Setup time | ~30 min | ~2 hours (CDK + first image) |
| IaC | docker-compose.yml | CDK (TypeScript) |
| Surprise bill risk | Zero (flat rate) | Moderate (misconfig can spike) |

The AWS path wins on scale-to-zero, IaC, and the cloud-architecture story for the thesis. The VPS path wins on simplicity, predictability, and zero cold starts.

---

## Destroying everything

```bash
# Empty S3 buckets first (RemovalPolicy.RETAIN protects them otherwise)
aws s3 rm s3://<bucket-name> --recursive

# Then destroy stacks in reverse order
pnpm destroy:all
```

Be aware that `LcaSharedStack`'s S3 buckets and ECR repo have `RemovalPolicy.RETAIN` — they survive `cdk destroy`. Override only if you really want a clean slate.
