# Web runtime configuration (AR-17, web half)

**Goal:** one web image, built once, runs unchanged in QA, UAT and production. Today every
web image bakes its addresses in at build time (`NEXT_PUBLIC_*` are inlined by Next), so the
image QA tested is not the image production runs.

## How it works

1. Each web app serves `GET /runtime-config.js` (`app/runtime-config.js/route.ts`,
   `force-dynamic`, `cache-control: no-store`). It reads the container's environment at
   request time and assigns `window.__ETG_RUNTIME_CONFIG__`.
2. The root layout loads it with `next/script` `strategy="beforeInteractive"`, which Next runs
   before hydration.
3. Code reads values through `runtimeValue(key, process.env.NEXT_PUBLIC_<KEY>)`
   (`@eticketsgo/web-kit/runtime-config`): the browser prefers the served value, the server
   prefers its own environment, and the inlined build value is the fallback.

**No new variables.** The server reads the variables the services already have
(`NEXT_PUBLIC_API_URL`, ...) by a computed name, which Next does not inline. An explicit
`ETG_PUBLIC_<KEY>` overrides it. Nothing changes for an environment that sets nothing new.

**Only public values.** The served keys are an allowlist (`API_URL`, `APP_ENV`, `SITE_URL`,
`ORGANIZER_URL`, `ADMIN_URL`, `STOREFRONT_URL`, `APP_RETURN_SCHEME`). All are already in every
bundle today. URL keys must be absolute http(s) without credentials, `APP_ENV` a plain word;
anything else is dropped and the build value used. The JSON is escaped for a script context.

## What reads the runtime value now

| Value               | Where                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `API_URL`           | every request in `web-kit` (`apiUrl()`), admin fee policies, storefront sitemap and event/film metadata |
| `ORGANIZER_URL`     | storefront links and handoff to the organizer console (`organizerUrl()`)                                |
| `ADMIN_URL`         | storefront and organizer console links to the admin console                                             |
| `STOREFRONT_URL`    | organizer console links to the storefront                                                               |
| `APP_ENV`           | storefront test-environment marker and footer build id                                                  |
| `APP_RETURN_SCHEME` | hosted-checkout return to the native app                                                                |

`API_URL` (the constant) is still exported with the build value for compatibility.

## Still build-time (do not promote a web image across environments yet)

| Value                 | Where                                                                                              | Why it matters                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `SITE_URL`, `APP_ENV` | `next.config.mjs` `headers()` (`X-Robots-Tag` on every response) and `middleware.ts` (`INDEXABLE`) | A QA-built image in production would send `noindex` on the live site. |
| `SITE_URL`            | `lib/seo.ts`, `lib/site-url.ts` (canonical URLs, JSON-LD); statically prerendered pages            | Canonical links would name the build environment's host.              |
| build id              | `lib/build-id.ts`                                                                                  | Shows the build, which is correct for a promoted image.               |

Next steps, each its own PR: move the robots header from `next.config.mjs` into the middleware
and read it per request; make the canonical-site helpers call `runtimeValue('SITE_URL', ...)`
and mark the pages that use them dynamic (or render canonical links client-side); then add
the three web services to `build-images.yml` and the promotion script.

## Verified (2026-11-06)

customer-web built with `NEXT_PUBLIC_API_URL=http://build-time.invalid/api`, started as the
standalone server (as the Dockerfile does) with `NEXT_PUBLIC_API_URL=http://127.0.0.1:4987/api`:

- `/runtime-config.js` answered 200, `application/javascript`, `no-store`, with the runtime
  values; `window.__ETG_RUNTIME_CONFIG__` held them in a real Chromium page;
- the browser's API calls and the server's render went to the runtime API; **zero** requests to
  the build-time host;
- the build-time value is still inlined in the bundle (the fallback).

## Rollback

Revert the PR. The build values were never removed, so a reverted build behaves as before.
