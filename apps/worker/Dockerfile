# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# ETicketsGo background worker (BullMQ hold-expiry + notification sweep).
# Build from the REPOSITORY ROOT (monorepo context):
#   docker build -f apps/worker/Dockerfile -t eticketsgo-worker .
# The worker imports @eticketsgo/api at runtime, so the API is built too.
# ─────────────────────────────────────────────────────────────

# ---------- Stage 1: deps ----------
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/validation/package.json packages/validation/
COPY packages/web-kit/package.json packages/web-kit/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/customer-web/package.json apps/customer-web/
COPY apps/organizer-web/package.json apps/organizer-web/
COPY apps/admin-web/package.json apps/admin-web/
COPY apps/e2e/package.json apps/e2e/

RUN npm ci

# ---------- Stage 2: build ----------
FROM deps AS build
WORKDIR /app
COPY . .
# Building the worker also builds its @eticketsgo/api dependency (turbo ^build).
RUN npm run packages:build \
  && npm run db:generate \
  && npx turbo run build --filter=@eticketsgo/worker
RUN npm prune --omit=dev

# ---------- Stage 3: runtime ----------
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl wget
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
# The worker resolves @eticketsgo/api -> apps/api (dist + Prisma client at runtime).
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json

USER node

WORKDIR /app/apps/worker
EXPOSE 4100
ENV WORKER_PORT=4100

# Liveness: the worker serves GET /health on WORKER_PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:4100/health || exit 1

CMD ["node", "dist/main.js"]
