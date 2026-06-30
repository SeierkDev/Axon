# ── Stage 1: dependencies ──────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Required for better-sqlite3 native compilation via node-gyp. Retried for the
# same reason as the curl step below — transient Alpine index errors.
RUN apk add --no-cache python3 make g++ \
    || (echo "apk build-deps retry 1 (transient Alpine index)…" && sleep 8 && apk add --no-cache python3 make g++) \
    || (echo "apk build-deps retry 2…" && sleep 20 && apk add --no-cache python3 make g++)

COPY package.json package-lock.json ./
# Install production + dev deps (needed for Next.js build)
RUN npm ci

# ── Stage 2: build ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Skip telemetry; enable standalone output
ENV NEXT_TELEMETRY_DISABLED=1
ENV DOCKER_BUILD=1

# NEXT_PUBLIC_* values are inlined into the client bundle DURING `next build`,
# so they must be declared as build args here. Declaring them also makes their
# values part of Docker's layer-cache key — without this, changing a variable
# on Railway silently reuses the old cached build (which is exactly what
# swallowed NEXT_PUBLIC_PRESENCE_URL).
ARG NEXT_PUBLIC_PRESENCE_URL
ARG NEXT_PUBLIC_HELIUS_URL
ARG NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS
ARG NEXT_PUBLIC_WALLET_ADDRESS
ARG NEXT_PUBLIC_AXON_REWARDS_ENABLED
ENV NEXT_PUBLIC_PRESENCE_URL=$NEXT_PUBLIC_PRESENCE_URL
ENV NEXT_PUBLIC_HELIUS_URL=$NEXT_PUBLIC_HELIUS_URL
ENV NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS=$NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS
ENV NEXT_PUBLIC_WALLET_ADDRESS=$NEXT_PUBLIC_WALLET_ADDRESS
ENV NEXT_PUBLIC_AXON_REWARDS_ENABLED=$NEXT_PUBLIC_AXON_REWARDS_ENABLED

# `npm run build` uses `next build --webpack` on purpose. Turbopack's standalone
# output does NOT copy instrumentation.js into .next/standalone, so the
# instrumentation register() hook never runs in production — and that hook is what
# starts the in-process background worker. Webpack includes it. Do not drop --webpack.
RUN npm run build

# ── Stage 3: runtime ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Only copy what the production server needs
COPY --from=builder /app/public          ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static    ./.next/static
# Migration .sql files are read from disk at runtime (not bundled into Next's
# standalone trace). Without this, applyMigrations() finds no migrations and new
# tables are never created in production — every new migration silently no-ops.
COPY --from=builder /app/migrations      ./migrations

# curl is needed by Railway cron services that use sh -c 'curl ...' as their
# start command. Retried — this step has repeatedly failed the build on transient
# Alpine CDN/index errors (e.g. "v2 database format error"). Each --no-cache
# attempt re-fetches the index, so a brief upstream blip self-heals.
RUN apk add --no-cache curl \
    || (echo "apk curl retry 1 (transient Alpine index)…" && sleep 8 && apk add --no-cache curl) \
    || (echo "apk curl retry 2…" && sleep 20 && apk add --no-cache curl)

# SQLite data directory — mount a Railway Volume at /data in production
RUN mkdir -p /data

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DATABASE_PATH=/data/axon.db
ENV NODE_OPTIONS="--max-old-space-size=512"

CMD ["node", "server.js"]
