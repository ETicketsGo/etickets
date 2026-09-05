# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# ETicketsGo API (NestJS + Prisma) — production image.
# Build from the REPOSITORY ROOT (monorepo context):
#   docker build -f apps/api/Dockerfile -t eticketsgo-api .
# Multi-stage: deps → build → slim runtime (node:20-alpine, non-root).
# ─────────────────────────────────────────────────────────────

# ---------- Stage 1: deps (full install, cached on manifests) ----------
FROM node:20-alpine AS deps
# openssl + libc6-compat: Prisma query-engine needs them on musl/alpine.
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# Copy only manifests first so `npm ci` is cached until a manifest changes.
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
# Build shared packages, generate the Prisma client, compile the Nest app.
RUN npm run packages:build \
  && npm run db:generate \
  && npx turbo run build --filter=@eticketsgo/api
# NOTE: dev dependencies are intentionally kept in this image because the Prisma
# CLI (a devDependency) is required to run `prisma migrate deploy` at deploy time
# (see docker-compose.prod.yml's one-shot `migrate` service). If you move
# migrations entirely out-of-band, you can add `RUN npm prune --omit=dev` here to
# slim the image (the generated client under node_modules/.prisma survives prune).

# ---------- Stage 3: runtime ----------
FROM node:20-alpine AS runtime
# postgresql-client is here for ONE reason: `pg_dump`, so the db-seed service (which reuses
# this image, because that is where prisma/ lives) can take a real recovery point before any
# destructive operation. Railway's own volume backups need account-level credentials that a
# project token does not have, so without this there is no backup this platform can take of
# itself. Roughly 15MB, and it changes nothing about how the API runs.
RUN apk add --no-cache openssl wget postgresql16-client
ENV NODE_ENV=production
WORKDIR /app

# node_modules incl. generated Prisma client, the Prisma CLI, and workspace symlinks.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# Workspace packages the API imports at runtime (resolved via node_modules symlinks).
COPY --from=build /app/packages ./packages
# The compiled API + Prisma schema/migrations (migrate deploy runs from here).
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/prisma ./apps/api/prisma

# Run as the built-in unprivileged `node` user.
USER node

WORKDIR /app/apps/api
EXPOSE 4000
ENV API_PORT=4000

# Liveness: the process serves GET /api/health (never touches DB/Redis).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:4000/api/health || exit 1

CMD ["node", "dist/main.js"]
