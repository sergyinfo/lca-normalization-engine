# Multi-stage build for the analytics-web Next.js 15 app.
#
# Build the data file on the host FIRST:
#   pnpm --filter analytics-web build:data
# Then build the image:
#   docker compose build analytics-web
#
# Why on the host: building lca.db requires connectivity to the Postgres
# matviews. That's available on the host (or wherever your operator runs)
# but not from a vanilla `docker build` context. The script writes the file
# into apps/analytics-web/data/lca.db, which this image copies in.
#
# Image layout:
#   /app/server.js                          Next standalone entry (from .next/standalone)
#   /app/apps/analytics-web/.next/static    Static assets
#   /app/apps/analytics-web/public          Public files
#   /app/apps/analytics-web/data/lca.db     Read-only dataset, baked in
#   /keys/keys.db                            Mutable, mounted as a volume

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# ---------- deps stage ----------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db-lib/package.json        ./packages/db-lib/
COPY apps/analytics-web/package.json     ./apps/analytics-web/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter analytics-web...

# ---------- build stage ---------------------------------------------------
FROM base AS builder
COPY --from=deps /app /app
COPY packages/db-lib/    ./packages/db-lib/
COPY apps/analytics-web/ ./apps/analytics-web/

# lca.db must be present (built on host via `pnpm --filter analytics-web build:data`).
RUN test -f apps/analytics-web/data/lca.db || \
    (echo "" && \
     echo "ERROR: apps/analytics-web/data/lca.db missing." && \
     echo "Run 'pnpm --filter analytics-web build:data' on the host before docker build." && \
     echo "" && \
     exit 1)

WORKDIR /app/apps/analytics-web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm next build

# ---------- runtime stage -------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV LCA_SQLITE_PATH=/app/apps/analytics-web/data/lca.db
ENV LCA_KEYS_DB_PATH=/keys/keys.db

# Standalone output (server.js + minimal node_modules) — the bulk of the image.
COPY --from=builder --chown=nextjs:nodejs /app/apps/analytics-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/analytics-web/.next/static     ./apps/analytics-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/analytics-web/public           ./apps/analytics-web/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/analytics-web/data/lca.db      ./apps/analytics-web/data/lca.db

# Mountpoint for the mutable keys.db. Created here so the dir exists if the
# volume isn't bound; the keys-db library auto-creates the file on first use.
RUN mkdir -p /keys && chown nextjs:nodejs /keys

USER nextjs
EXPOSE 3000
CMD ["node", "apps/analytics-web/server.js"]
