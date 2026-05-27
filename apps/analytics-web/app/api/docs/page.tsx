import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Code, Lock, Gauge } from 'lucide-react';

import { SITE_NAME, SITE_URL } from '@/lib/site';
import { entityMetadata } from '@/lib/seo';
import { FEATURES } from '@/lib/features';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

export const metadata: Metadata = entityMetadata({
  title: 'API Documentation',
  description: `Programmatic access to ${SITE_NAME}'s normalised US H-1B / LCA dataset. JSON endpoints, API-key auth, tiered rate limits.`,
  path: '/api/docs',
});

const E = SITE_URL;

export default function ApiDocsPage() {
  if (!FEATURES.api) notFound();
  return (
    <>
      <section className="space-y-3 pb-8">
        <Badge variant="secondary" className="rounded-full gap-1.5">
          <Code className="size-3" /> Developer API
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">API documentation</h1>
        <p className="text-muted-foreground max-w-2xl leading-relaxed">
          Programmatic access to the {SITE_NAME} dataset. Read-only JSON,
          Bearer-token auth, daily rate limits per tier. Same data as the
          public site, with stable URLs back to every entity page so you can
          deep-link cited rows.
        </p>
      </section>

      {/* ---------------------------------------------------- Authentication */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="size-4 text-primary" /> Authentication
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Every endpoint requires an API key — Bearer token or custom header:
          </p>
          <CodeBlock>
{`curl ${E}/api/v1/kpis \\
  -H "Authorization: Bearer lcak_..."

curl ${E}/api/v1/kpis \\
  -H "X-API-Key: lcak_..."`}
          </CodeBlock>
          <p className="text-sm text-muted-foreground">
            Keys begin with the prefix <Code1>lcak_</Code1>. They&rsquo;re tied
            to a tier; the same key is used across every endpoint.
          </p>
        </CardContent>
      </Card>

      {/* ----------------------------------------------------- Rate limits  */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="size-4 text-primary" /> Rate limits
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-0 pb-0">
          <div className="px-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Requests / day</TableHead>
                  <TableHead>Best for</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell><strong>Free</strong></TableCell><TableCell className="text-right tabular-nums">100</TableCell><TableCell>Trial, occasional lookups</TableCell></TableRow>
                <TableRow><TableCell><strong>Pro</strong></TableCell><TableCell className="text-right tabular-nums">10,000</TableCell><TableCell>Production apps, HR tooling</TableCell></TableRow>
                <TableRow><TableCell><strong>Enterprise</strong></TableCell><TableCell className="text-right tabular-nums">1,000,000</TableCell><TableCell>Bulk integrations</TableCell></TableRow>
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-6 py-4 space-y-2">
            <p className="text-sm text-muted-foreground">Every JSON response includes:</p>
            <CodeBlock>{`X-RateLimit-Limit:     10000
X-RateLimit-Remaining: 9987
X-RateLimit-Reset:     71834     # seconds until window resets`}</CodeBlock>
            <p className="text-sm text-muted-foreground">
              Hitting the limit returns <Code1>429 Too Many Requests</Code1> with
              a <Code1>Retry-After</Code1> header.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ----------------------------------------------------- Envelope     */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Response envelope</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <CodeBlock>{`{
  "data": {...},
  "meta": { "page": 1, "limit": 50, "total": 50 }
}`}</CodeBlock>
          <p className="text-sm text-muted-foreground">Errors:</p>
          <CodeBlock>{`{
  "error": {
    "code":    "unauthorized" | "forbidden" | "not_found" | "rate_limit_exceeded",
    "message": "..."
  }
}`}</CodeBlock>
        </CardContent>
      </Card>

      {/* ----------------------------------------------------- Endpoints    */}
      <h2 className="text-2xl font-semibold tracking-tight mt-10 mb-4">Endpoints</h2>

      <div className="space-y-4">
        <Endpoint
          method="GET" path="/api/v1/kpis"
          desc="Overview KPIs: total records, distinct sponsors and SOCs, median wage, year range."
          example={`${E}/api/v1/kpis`}
        />

        <Endpoint
          method="GET" path="/api/v1/employer"
          desc="Paginated list of all H-1B sponsors in the dataset."
          params={[
            { name: 'limit', desc: '1–200, default 50' },
            { name: 'page',  desc: 'default 1' },
          ]}
          example={`${E}/api/v1/employer?limit=20&page=1`}
        />
        <Endpoint
          method="GET" path="/api/v1/employer/{slug}"
          desc="Single sponsor profile: outcome rates, top occupations sponsored, yearly volume."
          example={`${E}/api/v1/employer/cognizant-technology-solutions-us-corp`}
        />

        <Endpoint
          method="GET" path="/api/v1/occupation"
          desc="Paginated list of SOC occupations covered."
          params={[
            { name: 'limit', desc: '1–200, default 50' },
            { name: 'page',  desc: 'default 1' },
          ]}
          example={`${E}/api/v1/occupation?limit=10`}
        />
        <Endpoint
          method="GET" path="/api/v1/occupation/{slug}"
          desc="Single SOC salary guide: P25 / P50 / P75 by wage level, top hiring states, top employers, yearly wage trend."
          example={`${E}/api/v1/occupation/software-developers-15-1252`}
        />

        <Endpoint
          method="GET" path="/api/v1/state"
          desc="All US states with H-1B filing volume."
          example={`${E}/api/v1/state`}
        />
        <Endpoint
          method="GET" path="/api/v1/state/{slug}"
          desc="Per-state detail: top sponsoring employers, top occupations."
          example={`${E}/api/v1/state/california-ca`}
        />

        <Endpoint
          method="GET" path="/api/v1/sector"
          desc="NAICS-2 sector breakdown of H-1B sponsorship."
          example={`${E}/api/v1/sector`}
        />
        <Endpoint
          method="GET" path="/api/v1/sector/{slug}"
          desc="Single NAICS sector profile."
          example={`${E}/api/v1/sector/professional-scientific-and-technical-services-54`}
        />
      </div>

      {/* ----------------------------------------------------- Freshness    */}
      <Card className="mt-10">
        <CardHeader>
          <CardTitle>Data freshness</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            The dataset is rebuilt quarterly when the US Department of Labor
            publishes new LCA disclosures. All endpoints carry a{' '}
            <Code1>Cache-Control: public, max-age=300</Code1> header — feel free
            to cache aggressively on your side.
          </p>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle>Licensing</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The underlying DOL disclosures are US public-domain data. Our
          normalisation, entity resolution, and aggregations are released
          under{' '}
          <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener" className="text-primary hover:underline">CC0</a>.
          Attribution to {SITE_NAME} is appreciated but not required.
        </CardContent>
      </Card>

      <Card className="mt-4 mb-4">
        <CardHeader><CardTitle>Getting a key</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          During the closed-beta period, keys are provisioned by hand. Email{' '}
          <Code1>api@{SITE_URL.replace(/^https?:\/\//, '')}</Code1> with a
          one-line description of your use case and we&rsquo;ll issue a Pro key.
        </CardContent>
      </Card>
    </>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-slate-900 text-slate-100 px-4 py-3 text-xs font-mono leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function Code1({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs rounded bg-muted px-1.5 py-0.5">{children}</code>;
}

interface Param { name: string; desc: string }

function Endpoint({
  method, path, desc, params, example,
}: { method: string; path: string; desc: string; params?: Param[]; example: string }) {
  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center gap-3">
          <Badge className="bg-primary text-primary-foreground font-bold tracking-wider">{method}</Badge>
          <code className="font-mono text-sm">{path}</code>
        </div>
        <p className="text-sm text-muted-foreground">{desc}</p>
        {params && params.length > 0 ? (
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {params.map((p) => (
              <li key={p.name}><Code1>{p.name}</Code1> — {p.desc}</li>
            ))}
          </ul>
        ) : null}
        <CodeBlock>{`curl "${example}" -H "Authorization: Bearer $LCA_KEY"`}</CodeBlock>
      </CardContent>
    </Card>
  );
}
