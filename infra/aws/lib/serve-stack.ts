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
import * as iam from 'aws-cdk-lib/aws-iam';
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

    // Optional shared secret CloudFront injects as the `x-origin-verify` header.
    // The app middleware 403s any request lacking it, so the public Function URL
    // can't be reached directly (only via CloudFront). Pass -c originVerifySecret=…
    const originVerifySecret = this.node.tryGetContext('originVerifySecret') as string | undefined;

    // Hosts that SHOULD be indexed by search engines (i.e. production). Any
    // served host NOT in this list gets an `X-Robots-Tag: noindex, nofollow`
    // response header, so dev/staging never competes with prod. Empty by
    // default ⇒ everything is noindex; set at prod promotion:
    //   -c indexableHosts=h1b.report,www.h1b.report
    const indexableHosts = ((this.node.tryGetContext('indexableHosts') as string | undefined) ?? '')
      .split(',').map((d) => d.trim()).filter(Boolean);

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
        ...(originVerifySecret ? { ORIGIN_VERIFY_SECRET: originVerifySecret } : {}),
      },
    });

    // Function URL → CloudFront origin. Cheaper + lower-latency than API Gateway.
    // Public Function URL fronted by CloudFront. We deliberately do NOT use
    // OAC/AWS_IAM here: CloudFront OAC signing against a Lambda Function URL was
    // reproducibly rejected (403) in this account even with a from-scratch,
    // spec-correct OAC setup. AuthType NONE + a public invoke grant is the
    // simple, reliable pattern. SECURITY: the Function URL is then directly
    // reachable, bypassing CloudFront. Acceptable for dev; for prod, add a
    // secret header on the CloudFront origin and verify it in the app/edge.
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      // Must match the image's AWS_LWA_INVOKE_MODE=response_stream. With BUFFERED
      // the Lambda Web Adapter streams but the URL buffers → empty (content-length 0)
      // responses even on a 200. RESPONSE_STREAM also enables Next.js streaming SSR.
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });
    // Allow anonymous invocation of the (AuthType NONE) Function URL.
    fnUrl.grantInvokeUrl(new iam.AnyPrincipal());

    // ---------------------------------------------------------------------
    // CloudFront distribution.
    // ---------------------------------------------------------------------
    const oai = new cf.OriginAccessIdentity(this, 'StaticOai', {
      comment: 'OAI for static asset bucket',
    });
    staticBucket.grantRead(oai);

    // Plain Function URL origin (no OAC) — the URL is public (AuthType NONE).
    // CloudFront stamps the shared secret header so the app can tell its own
    // traffic apart from direct Function-URL hits.
    const lambdaOrigin = new origins.FunctionUrlOrigin(fnUrl, {
      ...(originVerifySecret ? { customHeaders: { 'x-origin-verify': originVerifySecret } } : {}),
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

    // Origin request policy for the OAC-signed Lambda origin. It must forward
    // viewer headers but EXCLUDE `authorization` (and `host`): CloudFront OAC
    // injects its SigV4 signature into the Authorization header, so if that
    // header is in the forwarded allowlist CloudFront passes the (empty) viewer
    // value through instead of signing → the Function URL 403s. The managed
    // ALL_VIEWER_EXCEPT_HOST_HEADER policy forwards Authorization and breaks OAC.
    const lambdaOriginRequestPolicy = new cf.OriginRequestPolicy(this, 'LambdaOriginReqPolicy', {
      comment: 'All viewer headers except Host + Authorization (OAC injects the SigV4 Authorization).',
      headerBehavior: cf.OriginRequestHeaderBehavior.denyList('host', 'authorization'),
      cookieBehavior: cf.OriginRequestCookieBehavior.all(),
      queryStringBehavior: cf.OriginRequestQueryStringBehavior.all(),
    });

    // Canonical-host redirect (viewer-request CloudFront Function). The
    // distribution always answers on its *.cloudfront.net domain too, which
    // would serve duplicate content. 301 any request whose Host isn't an
    // approved domain (cloudfront.net, www, …) to the primary domain. Only
    // attached when custom domains are configured.
    const canonicalRedirectFn = siteDomains.length > 0
      ? new cf.Function(this, 'CanonicalHostRedirect', {
          comment: 'Redirect non-canonical hosts (*.cloudfront.net, etc.) to the primary domain',
          code: cf.FunctionCode.fromInline([
            'function handler(event){',
            '  var request=event.request;',
            '  var host=request.headers.host?request.headers.host.value:"";',
            `  var allow=${JSON.stringify(siteDomains)};`,
            '  for(var i=0;i<allow.length;i++){if(host===allow[i]){return request;}}',
            '  var qs="";for(var k in request.querystring){qs+=(qs?"&":"?")+k+"="+request.querystring[k].value;}',
            `  return{statusCode:301,statusDescription:"Moved Permanently",headers:{location:{value:"https://${siteDomains[0]}"+request.uri+qs}}};`,
            '}',
          ].join('\n')),
        })
      : undefined;
    const canonicalFnAssoc = canonicalRedirectFn
      ? [{ function: canonicalRedirectFn, eventType: cf.FunctionEventType.VIEWER_REQUEST }]
      : undefined;

    // noindex non-production hosts (viewer-response). Runs only for requests
    // that passed the canonical redirect (i.e. an allowed host); stamps a
    // noindex header unless the host is explicitly indexable.
    const noindexFn = siteDomains.length > 0
      ? new cf.Function(this, 'NoindexNonProd', {
          comment: 'Add X-Robots-Tag: noindex on non-production hosts so dev/staging does not compete with prod',
          code: cf.FunctionCode.fromInline([
            'function handler(event){',
            '  var request=event.request;var response=event.response;',
            '  var host=request.headers.host?request.headers.host.value:"";',
            `  var indexable=${JSON.stringify(indexableHosts)};`,
            '  for(var i=0;i<indexable.length;i++){if(host===indexable[i]){return response;}}',
            '  response.headers["x-robots-tag"]={value:"noindex, nofollow"};',
            '  return response;',
            '}',
          ].join('\n')),
        })
      : undefined;

    // Default behavior runs both: canonical redirect (request) + noindex (response).
    const defaultFnAssoc = [
      ...(canonicalFnAssoc ?? []),
      ...(noindexFn ? [{ function: noindexFn, eventType: cf.FunctionEventType.VIEWER_RESPONSE }] : []),
    ];

    const distribution = new cf.Distribution(this, 'Distribution', {
      // Custom domain wiring is optional — only attached when context is set.
      ...(siteCert ? { domainNames: siteDomains, certificate: siteCert } : {}),
      minimumProtocolVersion: cf.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: lambdaOrigin,
        allowedMethods: cf.AllowedMethods.ALLOW_ALL,
        cachePolicy: cf.CachePolicy.CACHING_DISABLED,   // dynamic routes
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        originRequestPolicy: lambdaOriginRequestPolicy,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: defaultFnAssoc.length ? defaultFnAssoc : undefined,
      },
      additionalBehaviors: {
        // Hashed JS/CSS — cache forever
        '/_next/static/*': {
          origin: s3Origin,
          cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy: securityHeaders,
          functionAssociations: canonicalFnAssoc,
        },
        // Public assets (favicon, /public/*, OG images placeholders)
        '/static/*': {
          origin: s3Origin,
          cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          functionAssociations: canonicalFnAssoc,
        },
        // NOTE: /sitemap.xml and /robots.txt are NOT routed to S3 — this Next app
        // serves them as (statically-prerendered) dynamic routes from the Lambda
        // standalone server, not as files in .next/static. Routing them to the
        // (empty) static bucket 404s. They fall through to the default Lambda
        // behavior instead.
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
