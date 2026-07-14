# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# ETicketsGo customer web (Next.js 14, standalone output) — port 3000.
# Build from the REPOSITORY ROOT (monorepo context):
#   docker build -f apps/customer-web/Dockerfile -t eticketsgo-customer-web .
# NEXT_PUBLIC_* are inlined at build time — pass NEXT_PUBLIC_API_URL as a build arg.
# ─────────────────────────────────────────────────────────────

ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api

# ---------- Stage 1: deps ----------
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
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
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY . .
# turbo builds the transpiled workspace packages first (^build), then the app.
RUN npx turbo run build --filter=@eticketsgo/customer-web

# ---------- Stage 3: runtime (standalone) ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Standalone server bundle (self-contained: minimal node_modules + traced deps).
COPY --from=build /app/apps/customer-web/.next/standalone ./
# Static assets are NOT included in standalone; copy them alongside the server.
COPY --from=build /app/apps/customer-web/.next/static ./apps/customer-web/.next/static

USER node

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/customer-web/server.js"]
