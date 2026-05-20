# AWS-native deployment (CDK)

This directory holds the CDK templates that deploy the analytics web app
and its data pipeline to AWS. Three independent stacks, deployed in order:

1. **`LcaSharedStack`** — S3 buckets, Secrets Manager entries, ECR repo
2. **`LcaDataPipelineStack`** — burst data ops (EventBridge → Step Fn → EC2)
3. **`LcaServeStack`** — CloudFront + Lambda Container Image + S3 static

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
