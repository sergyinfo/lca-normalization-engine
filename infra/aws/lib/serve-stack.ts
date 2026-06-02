/**
 * Always-on serving for the public site.
 *
 *   Internet
 *      ▼
 *   CloudFront  ─[default]─►  Lambda Container (Next.js standalone via AWS LWA)
 *               ─[static]──►  S3 bucket (pre-rendered HTML, JS, CSS, sitemap)
 *
 * The Lambda image holds the full Next.js standalone build + lca.db baked in.
 * It serves all dynamic routes: /search, /api/v1/*, /compare on-demand,
 * /archive/* runtime reads, /opengraph-image. Static HTML pages are served
 * from S3 via a CloudFront cache behavior override.
 *
 * Cold-start latency: ~500–1000ms on first hit after idle. For a site with
 * sporadic SEO traffic, this is fine. Add `provisionedConcurrentExecutions`
 * if you need sub-second p99.
 */

import { Stack, StackProps, Duration, RemovalPolicy, Tags, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type { LcaSharedStack } from './shared-stack.js';

interface ServeStackProps extends StackProps {
  shared: LcaSharedStack;
}

export class LcaServeStack extends Stack {
  constructor(scope: Construct, id: string, props: ServeStackProps) {
    super(scope, id, props);
    const { shared } = props;

    Tags.of(this).add('Component', 'serve');

    // ---------------------------------------------------------------------
    // Per-environment wiring, sourced from CDK context so secrets/ARNs stay
    // out of source control. Pass on deploy, e.g.:
    //   cdk deploy LcaServeStack \
    //     -c siteCertificateArn=arn:aws:acm:us-east-1:…:certificate/… \
    //     -c siteDomains=dev.h1b.report \
    //     -c siteUrl=https://dev.h1b.report
    //
    // Domain wiring is OPTIONAL: with no cert/domains context the stack still
    // synths and deploys against the raw *.cloudfront.net hostname (handy for
    // the very first deploy, before the ACM cert exists / is Issued).
    // ---------------------------------------------------------------------
    const siteCertificateArn = this.node.tryGetContext('siteCertificateArn') as string | undefined;
    const siteDomains = ((this.node.tryGetContext('siteDomains') as string | undefined) ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    const siteUrl = (this.node.tryGetContext('siteUrl') as string | undefined) ?? 'https://h1b.report';

    if (siteCertificateArn && siteDomains.length === 0) {
      throw new Error('siteCertificateArn provided but siteDomains is empty — set -c siteDomains=dev.h1b.report');
    }
    if (siteDomains.length > 0 && !siteCertificateArn) {
      throw new Error('siteDomains provided but siteCertificateArn is missing — CloudFront aliases require an ACM cert in us-east-1');
    }
    const siteCert = siteCertificateArn
      ? acm.Certificate.fromCertificateArn(this, 'SiteCert', siteCertificateArn)
      : undefined;

    // ---------------------------------------------------------------------
    // S3 bucket holding static Next.js assets uploaded out-of-band by the
    // build pipeline. Pre-rendered HTML pages + /_next/static/* JS/CSS.
    // ---------------------------------------------------------------------
    const staticBucket = new s3.Bucket(this, 'StaticAssetsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------------
    // Lambda function — runs the Next.js standalone server inside a
    // container, fronted by AWS Lambda Web Adapter (no Next.js adapter
    // refactor needed, no Vercel-only bits).
    // ---------------------------------------------------------------------
    const fn = new lambda.DockerImageFunction(this, 'AnalyticsWebFn', {
      functionName: 'lca-analytics-web',
      code: lambda.DockerImageCode.fromEcr(shared.lambdaImageRepo, { tagOrDigest: 'latest' }),
      memorySize: 512,        // Headroom for SQLite + Next.js render
      timeout: Duration.seconds(15),
      logRetention: logs.RetentionDays.ONE_MONTH,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        // The lca.db is baked into the image; nothing to wire here for now.
        SITE_URL: siteUrl,
        ADSENSE_CLIENT_ID: '',   // set when you have a real one
      },
    });

    // Function URL → CloudFront origin. Cheaper + lower-latency than API Gateway.
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });

    // ---------------------------------------------------------------------
    // CloudFront distribution.
    // ---------------------------------------------------------------------
    const oai = new cf.OriginAccessIdentity(this, 'StaticOai', {
      comment: 'OAI for static asset bucket',
    });
    staticBucket.grantRead(oai);

    // Lambda origin must use a custom origin (its FN_URL is an HTTPS endpoint).
    // We use an Origin Access Control via CloudFront to sign requests with SigV4.
    const lambdaOrigin = new origins.FunctionUrlOrigin(fnUrl, {
      // No timeouts here — sub-15s Lambda timeout governs.
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessIdentity(staticBucket, {
      originAccessIdentity: oai,
    });

    const securityHeaders = new cf.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentTypeOptions:  { override: true },
        frameOptions:        { frameOption: cf.HeadersFrameOption.SAMEORIGIN, override: true },
        referrerPolicy:      { referrerPolicy: cf.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365), includeSubdomains: true, preload: true, override: true,
        },
        xssProtection:       { protection: true, modeBlock: true, override: true },
      },
    });

    const distribution = new cf.Distribution(this, 'Distribution', {
      // Custom domain wiring is optional — only attached when context is set.
      ...(siteCert ? { domainNames: siteDomains, certificate: siteCert } : {}),
      minimumProtocolVersion: cf.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: lambdaOrigin,
        allowedMethods: cf.AllowedMethods.ALLOW_ALL,
        cachePolicy: cf.CachePolicy.CACHING_DISABLED,   // dynamic routes
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: securityHeaders,
      },
      additionalBehaviors: {
        // Hashed JS/CSS — cache forever
        '/_next/static/*': {
          origin: s3Origin,
          cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy: securityHeaders,
        },
        // Public assets (favicon, /public/*, OG images placeholders)
        '/static/*': {
          origin: s3Origin,
          cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        '/sitemap.xml': {
          origin: s3Origin,
          cachePolicy: new cf.CachePolicy(this, 'SitemapCache', {
            defaultTtl: Duration.hours(6),
            maxTtl: Duration.days(1),
          }),
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        '/robots.txt': {
          origin: s3Origin,
          cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      priceClass: cf.PriceClass.PRICE_CLASS_100, // North America + Europe
      defaultRootObject: '',
      comment: 'LCA analytics web — CloudFront distribution',
    });

    // ---------------------------------------------------------------------
    // Outputs — consumed by infra/aws/scripts/{migrate-from-local,sync-static}.sh
    // and the Cloudflare DNS step (point dev/apex CNAME at DistributionDomainName).
    // ---------------------------------------------------------------------
    new CfnOutput(this, 'StaticAssetsBucketName', {
      value: staticBucket.bucketName,
      description: 'S3 bucket for /_next/static/* and /static/* assets. Sync via sync-static.sh.',
      exportName: 'LcaStaticAssetsBucket',
    });
    new CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront hostname. Point the Cloudflare dev/apex CNAME here.',
    });
  }
}
