# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# ETicketsGo admin web (Next.js 14, standalone output) — port 3002.
# Build from the REPOSITORY ROOT (monorepo context):
#   docker build -f apps/admin-web/Dockerfile -t eticketsgo-admin-web .
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
RUN npx turbo run build --filter=@eticketsgo/admin-web

# ---------- Stage 3: runtime (standalone) ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

COPY --from=build /app/apps/admin-web/.next/standalone ./
COPY --from=build /app/apps/admin-web/.next/static ./apps/admin-web/.next/static

USER node

EXPOSE 3002
ENV PORT=3002
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3002').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/admin-web/server.js"]
