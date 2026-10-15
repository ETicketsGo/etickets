# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# ETicketsGo organizer web (Next.js 14, standalone output) — port 3001.
# Build from the REPOSITORY ROOT (monorepo context):
#   docker build -f apps/organizer-web/Dockerfile -t eticketsgo-organizer-web .
# NEXT_PUBLIC_* are inlined at build time — pass NEXT_PUBLIC_API_URL as a build arg.
# ─────────────────────────────────────────────────────────────

ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api
# Optional. Where the sign-in page sends "Forgot your password?" and "Create an organizer
# account". Empty means "derive it from this console's host" (organizer-qa.x -> qa.x), which is
# right for every deployment named the usual way (apps/organizer-web/lib/storefront-url.ts).
ARG NEXT_PUBLIC_STOREFRONT_URL=
# Optional: the admin console's address, offered to an administrator who signs in here.
# Empty = derived from this console's host (organizer-qa. -> admin-qa.).
ARG NEXT_PUBLIC_ADMIN_URL=

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
ARG NEXT_PUBLIC_STOREFRONT_URL
ENV NEXT_PUBLIC_STOREFRONT_URL=${NEXT_PUBLIC_STOREFRONT_URL}
ARG NEXT_PUBLIC_ADMIN_URL
ENV NEXT_PUBLIC_ADMIN_URL=${NEXT_PUBLIC_ADMIN_URL}
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY . .
RUN npx turbo run build --filter=@eticketsgo/organizer-web

# ---------- Stage 3: runtime (standalone) ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

COPY --from=build /app/apps/organizer-web/.next/standalone ./
COPY --from=build /app/apps/organizer-web/.next/static ./apps/organizer-web/.next/static

USER node

EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/organizer-web/server.js"]
