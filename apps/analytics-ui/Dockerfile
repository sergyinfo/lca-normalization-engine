FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# ---- deps stage ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db-lib/package.json ./packages/db-lib/
COPY apps/analytics-ui/package.json ./apps/analytics-ui/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter analytics-ui... --prod

# ---- runtime stage ----
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/db-lib/node_modules ./packages/db-lib/node_modules
# pnpm installs each workspace package's deps into ITS OWN node_modules (symlinks
# into /app/node_modules/.pnpm). Without this the app can't resolve its dependencies.
COPY --from=deps /app/apps/analytics-ui/node_modules ./apps/analytics-ui/node_modules

COPY packages/db-lib/ ./packages/db-lib/
COPY apps/analytics-ui/ ./apps/analytics-ui/

WORKDIR /app/apps/analytics-ui
ENV NODE_ENV=production

EXPOSE 8081
CMD ["node", "index.js"]
