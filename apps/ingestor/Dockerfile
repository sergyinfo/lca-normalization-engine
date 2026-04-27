FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# ---- deps stage ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db-lib/package.json ./packages/db-lib/
COPY apps/ingestor/package.json ./apps/ingestor/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter ingestor... --prod

# ---- runtime stage ----
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/db-lib/node_modules ./packages/db-lib/node_modules

COPY packages/db-lib/ ./packages/db-lib/
COPY apps/ingestor/ ./apps/ingestor/

WORKDIR /app/apps/ingestor
ENV NODE_ENV=production

CMD ["node", "index.js"]
