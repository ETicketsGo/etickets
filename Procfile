# Process definitions for Railway / Heroku-style buildpack deploys (one process type each).
# On Railway prefer one SERVICE per process (Dockerfile-based) so API and worker scale + fail
# independently; this Procfile is the single-dyno / buildpack fallback.
#
# release runs migrations once per deploy BEFORE web/worker boot (safe: additive-only migrations).
release: npx --prefix apps/api prisma migrate deploy
web: node apps/api/dist/main.js
worker: node apps/worker/dist/main.js
