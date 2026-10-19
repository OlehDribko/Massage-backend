# syntax=docker/dockerfile:1
#
# Booking service image. Build context: repository root (npm workspaces).
#   docker build -f services/booking/Dockerfile --target runtime -t booking-api .
#   docker build -f services/booking/Dockerfile --target migrate -t booking-migrate .
# No secrets are passed at build time; the build never connects to a database.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# --- all dependencies (incl. dev: Prisma CLI, TypeScript) from the root lock file
FROM base AS deps
# OpenSSL lets Prisma pick the right schema-engine build (used by the migrate target).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY services/booking/package.json services/booking/
RUN --mount=type=cache,target=/root/.npm npm ci

# --- Prisma Client generation + TypeScript build (no database needed)
FROM deps AS build
COPY services/booking/tsconfig.json services/booking/tsconfig.build.json services/booking/prisma.config.ts services/booking/
COPY services/booking/prisma services/booking/prisma
COPY services/booking/src services/booking/src
WORKDIR /app/services/booking
# No MIGRATION_DATABASE_URL here: prisma.config.ts then defines no datasource,
# which `prisma generate` does not need.
RUN CHECKPOINT_DISABLE=1 node /app/node_modules/prisma/build/index.js generate \
    && npm run build

# --- production dependencies only
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY services/booking/package.json services/booking/
# prisma and typescript are dev dependencies but also optional peers of
# @prisma/client ("devOptional" in the lock file); npm keeps such packages
# unless optional ones are omitted too. Only pg-cloudflare (unused on Node)
# is otherwise affected.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --omit=optional

# --- one-off migration task: Prisma CLI + config + migrations, no application code
FROM base AS migrate
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
COPY --from=deps /app/node_modules /app/node_modules
COPY package.json package-lock.json ./
COPY services/booking/package.json services/booking/prisma.config.ts services/booking/
COPY services/booking/prisma services/booking/prisma
WORKDIR /app/services/booking
USER node
# Requires MIGRATION_DATABASE_URL at run time.
CMD ["node", "/app/node_modules/prisma/build/index.js", "migrate", "deploy"]

# --- API runtime (default target)
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY package.json ./
COPY services/booking/package.json services/booking/
COPY --from=build /app/services/booking/dist services/booking/dist
WORKDIR /app/services/booking
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
