# Cloudflare + AWS setup for `h1b.report`

End-to-end runbook for pointing the newly registered domain `h1b.report` at the
CloudFront distribution provisioned by `LcaServeStack`. Everything below is
copy-paste ready. Run the steps in order — each step has a verification command
at the bottom so you can confirm before moving on.

---

## 0. Architecture decision: DNS-only vs. Proxied

Cloudflare can either:

- **(A) DNS-only (grey cloud)** — Cloudflare resolves `h1b.report` to your
  CloudFront hostname; the browser then talks directly to CloudFront. TLS
  terminates at CloudFront with an ACM cert. *No* Cloudflare WAF / caching /
  bot protection.
- **(B) Proxied (orange cloud)** — Cloudflare sits in front of CloudFront. You
  get WAF, bot fight mode, analytics, and edge caching, at the cost of an extra
  hop and a slightly more complex TLS setup (must use **Full (Strict)**).

**Recommendation: start with (A), switch to (B) later** once the site is live
and you confirm CloudFront serves correctly. The DNS records are identical;
the only change is the orange/grey toggle in Cloudflare. The guide below
configures everything needed for either mode.

---

## 1. Add `h1b.report` to Cloudflare

1. Sign in to <https://dash.cloudflare.com> → **Add a site** → enter
   `h1b.report` → choose the **Free** plan.
2. Cloudflare will scan existing DNS (there won't be any) and show you two
   assigned authoritative nameservers, e.g.:

   ```
   adi.ns.cloudflare.com
   walt.ns.cloudflare.com
   ```

   **Write these down — they are unique to your zone.**

3. Go to your registrar's control panel (wherever you bought `h1b.report`),
   find the **Nameservers** section, switch from the default registrar NS to
   *Custom nameservers*, and paste the two Cloudflare hostnames.
4. Back in Cloudflare, click **Done, check nameservers**. Propagation usually
   completes within 15–60 minutes; Cloudflare emails you when the zone is
   active.

**Verify:**

```bash
dig +short NS h1b.report
# Should return the two *.ns.cloudflare.com hostnames you set.
```

---

## 2. Request the ACM certificate (us-east-1)

CloudFront accepts ACM certificates *only* from **us-east-1**, regardless of
where the rest of your stack lives. The CDK app already defaults to us-east-1,
so we're fine.

Easiest path is via the AWS console:

1. AWS Console → **Certificate Manager** (top right region: **N. Virginia /
   us-east-1**) → **Request** → *Public certificate*.
2. Fully-qualified domain names:
   - `h1b.report`
   - `www.h1b.report`
3. Validation method: **DNS validation** (faster + auto-renews).
4. Key algorithm: **RSA 2048** (default).
5. Submit. ACM shows two CNAME records (one per FQDN) that look like:

   ```
   _abc123.h1b.report      CNAME   _xyz.acm-validations.aws.
   _def456.www.h1b.report  CNAME   _uvw.acm-validations.aws.
   ```

6. In Cloudflare → **DNS → Records → Add record**, create both CNAMEs **with
   the proxy toggle set to DNS only (grey cloud)**. Cloudflare proxying breaks
   ACM validation.
7. Within ~5 minutes ACM flips both to **Issued**. Copy the certificate ARN
   (looks like `arn:aws:acm:us-east-1:123456789012:certificate/…`).

**Verify:**

```bash
aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='h1b.report'].[CertificateArn,Status]" \
  --output table
```

---

## 3. Wire the cert + domain into the CDK serve-stack

The current `lib/serve-stack.ts` defines a `cf.Distribution` without
`domainNames` or `certificate`. Update it as follows.

**Patch — `infra/aws/lib/serve-stack.ts`:**

1. Add the ACM import near the other imports:

   ```ts
   import * as acm from 'aws-cdk-lib/aws-certificatemanager';
   ```

2. Inside the `LcaServeStack` constructor, just before
   `new cf.Distribution(...)`, look up the cert by ARN (sourced from a CDK
   context value so it stays out of source control):

   ```ts
   const certArn = this.node.tryGetContext('siteCertificateArn');
   if (!certArn) {
     throw new Error('Missing CDK context "siteCertificateArn" — set it in cdk.json or via `cdk deploy -c siteCertificateArn=arn:aws:acm:...`');
   }
   const siteCert = acm.Certificate.fromCertificateArn(this, 'SiteCert', certArn);
   ```

3. Pass `domainNames` and `certificate` to the `Distribution`:

   ```ts
   new cf.Distribution(this, 'Distribution', {
     domainNames: ['h1b.report', 'www.h1b.report'],
     certificate: siteCert,
     minimumProtocolVersion: cf.SecurityPolicyProtocol.TLS_V1_2_2021,
     defaultBehavior: { /* unchanged */ },
     additionalBehaviors: { /* unchanged */ },
     priceClass: cf.PriceClass.PRICE_CLASS_100,
     defaultRootObject: '',
     comment: 'LCA analytics web — CloudFront distribution',
   });
   ```

4. Store the ARN in `infra/aws/cdk.json` under `context`:

   ```jsonc
   {
     "context": {
       "siteCertificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/…"
     }
   }
   ```

5. Deploy:

   ```bash
   cd infra/aws
   pnpm cdk deploy LcaServeStack
   ```

6. After deploy, grab the CloudFront distribution domain name (looks like
   `d1a2b3c4d5e6f7.cloudfront.net`):

   ```bash
   aws cloudfront list-distributions \
     --query "DistributionList.Items[?Aliases.Items && contains(Aliases.Items, 'h1b.report')].DomainName" \
     --output text
   ```

---

## 4. Add the DNS records in Cloudflare

Cloudflare supports *CNAME flattening* at the apex, so we can point the bare
`h1b.report` directly at the CloudFront hostname (no need for ALIAS/A records).

In Cloudflare → **DNS → Records**, add:

| Type   | Name             | Target                              | Proxy status      |
|--------|------------------|-------------------------------------|-------------------|
| CNAME  | `h1b.report`     | `<dist>.cloudfront.net`             | DNS only (grey)*  |
| CNAME  | `www`            | `<dist>.cloudfront.net`             | DNS only (grey)*  |
| CAA    | `h1b.report`     | `0 issue "amazon.com"`              | n/a               |
| CAA    | `h1b.report`     | `0 issuewild "amazon.com"`          | n/a               |
| CAA    | `h1b.report`     | `0 iodef "mailto:mail@sergy.info"`  | n/a               |

\* Start grey. Switch to orange (proxied) only after step 6 verifies the site.

The **CAA** records restrict which CAs can issue certificates for the domain
to AWS ACM — a cheap hijack-prevention measure. If you later switch to
Cloudflare proxied mode and want Cloudflare's edge cert, add
`0 issue "pki.goog"` and `0 issue "letsencrypt.org"` too.

**Verify:**

```bash
dig +short h1b.report
dig +short www.h1b.report
# Both should resolve to a CloudFront IP (no errors, NXDOMAIN, or SERVFAIL).

curl -sI https://h1b.report | head -n 5
# Expect HTTP/2 200 (or a redirect from Next.js) — no TLS errors.
```

---

## 5. Cloudflare SSL/TLS settings

Even in DNS-only mode the SSL/TLS panel governs Cloudflare's *future* proxy
behavior. Set it correctly now so flipping to orange-cloud is a no-op:

- **SSL/TLS → Overview**: Mode = **Full (Strict)**. Anything weaker
  (Flexible / Full) allows MITM or trusts self-signed origins.
- **SSL/TLS → Edge Certificates**:
  - *Always Use HTTPS*: **On**.
  - *Minimum TLS Version*: **TLS 1.2**.
  - *Opportunistic Encryption*: **On**.
  - *TLS 1.3*: **On**.
  - *Automatic HTTPS Rewrites*: **On**.
  - *HSTS*: **Enable** with `max-age = 31536000`, `includeSubDomains = on`,
    `preload = on`. (Your CDK `securityHeaders` policy already sets HSTS on
    the CloudFront responses; aligning Cloudflare avoids conflicting headers
    if you ever proxy.)

---

## 6. Email — Cloudflare Email Routing (free)

You don't need a mailbox; you just need `*@h1b.report` to forward to your
real inbox (`mail@sergy.info`) so DOL, registrars, ACM renewals, and abuse
contacts can reach you.

1. Cloudflare → **Email → Email Routing → Get started**.
2. Cloudflare offers to add the required DNS records automatically — accept.
   It installs:

   ```
   MX  h1b.report      route1.mx.cloudflare.net   priority 17
   MX  h1b.report      route2.mx.cloudflare.net   priority 56
   MX  h1b.report      route3.mx.cloudflare.net   priority 90
   TXT h1b.report      "v=spf1 include:_spf.mx.cloudflare.net ~all"
   ```

3. **Routing rules → Create address**:
   - Catch-all: `*@h1b.report` → `mail@sergy.info`.
   - (Optional) explicit aliases: `hello@`, `abuse@`, `security@`, `admin@`
     all → `mail@sergy.info`.
4. Cloudflare sends a verification email to `mail@sergy.info` — click the
   link before the routes activate.
5. Add DMARC manually (Email Routing doesn't add it for you):

   ```
   TXT  _dmarc.h1b.report   "v=DMARC1; p=reject; rua=mailto:mail@sergy.info; adkim=s; aspf=s"
   ```

   `p=reject` is safe because you're not *sending* mail from `h1b.report`. If
   you later send transactional mail through SES or similar, downgrade to
   `p=quarantine` first and add DKIM.

**Verify:**

```bash
dig +short MX h1b.report
dig +short TXT h1b.report           # SPF
dig +short TXT _dmarc.h1b.report    # DMARC
```

Send a test from any external account to `test@h1b.report` and confirm it
lands in `mail@sergy.info` within a minute.

---

## 7. Spoofing protection if you skip email entirely

If you decide you *don't* want any inbound mail, **don't just leave MX
records absent** — set explicit null MX + reject SPF so spoofers can't claim
your domain:

```
MX   h1b.report   .                      priority 0     # RFC 7505 null MX
TXT  h1b.report   "v=spf1 -all"
TXT  _dmarc.h1b.report  "v=DMARC1; p=reject; rua=mailto:mail@sergy.info"
```

(Skip this section entirely if you completed step 6.)

---

## 8. Final smoke test

```bash
# DNS resolves through Cloudflare NS
dig NS h1b.report +short

# Apex + www both reach CloudFront
curl -sI https://h1b.report  | head -n 10
curl -sI https://www.h1b.report | head -n 10

# HSTS header present
curl -sI https://h1b.report | grep -i strict-transport-security

# TLS chain valid, issued by Amazon
echo | openssl s_client -connect h1b.report:443 -servername h1b.report 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates

# Email forward works (send manually, confirm receipt)
```

Open <https://h1b.report> in a browser. You should see the Next.js app served
from the Lambda container, with the green padlock and no mixed-content
warnings.

---

## 9. (Optional) Flip to Cloudflare proxied mode

Once everything in step 8 is green:

1. Cloudflare → **DNS → Records** → toggle the two CNAMEs from grey to orange.
2. Confirm `curl -sI https://h1b.report` still returns 200 and the `server`
   header now reads `cloudflare`.
3. Cloudflare → **Security → WAF**: enable the *Cloudflare Managed Ruleset*
   and *Cloudflare OWASP Core Ruleset*; both are free.
4. Cloudflare → **Security → Bots**: turn on *Bot Fight Mode* (free) — it
   shields the Lambda from cheap scrapers and cuts CloudFront cost.
5. Cloudflare → **Caching → Configuration**: leave at defaults. CloudFront
   already caches `/_next/static/*` aggressively; Cloudflare will respect the
   `Cache-Control` headers CloudFront emits.

If a request loop appears (`ERR_TOO_MANY_REDIRECTS`), Cloudflare's SSL mode
is not **Full (Strict)** — fix step 5 before re-enabling proxying.

---

## Rollback

If anything goes wrong at the DNS layer, point the registrar nameservers back
to its default — `dig NS h1b.report` propagation is usually under an hour.
The ACM cert and CDK changes are non-destructive; you can keep them in place
across rollbacks.
