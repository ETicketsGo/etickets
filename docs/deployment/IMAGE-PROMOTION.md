# Build once, promote the same image: QA -> UAT -> PRODUCTION

Status: the build half, the gate on migrations and the promotion script are on branch
`feat/image-promotion`. **No environment has been switched to images.** The first promotion is
an infrastructure change that needs the owner's approval.

## Today (audited 2026-11-06)

- Railway builds every service from the repository in every environment, from the same
  Dockerfiles, with service variables passed as build arguments. One release is up to 15
  separate builds (5 services x 3 environments). Nothing records a digest; what was tested in
  QA is not byte-for-byte what runs in production.
- `deploy-railway.yml` uses `railway up` (uploads the tree; Railway builds it). The production
  path is the owner's local kit (`deploy-pinned.mjs` -> `serviceInstanceDeployV2(commitSha)`),
  which also rebuilds.
- `deploy.yml` builds and pushes images to GHCR, but records no digest and its deploy step is
  a placeholder. It is not used.
- **A variable change rebuilds from `main`** (proven twice; see the deploy kit notes). With an
  image source, a variable change would redeploy the SAME image instead. Expected from how
  Railway image services work, not yet verified here.
- Migrations: once per deploy in the api `preDeployCommand`. Nothing checked that a migration
  stays compatible with the previous release.
- The api and worker images are environment-neutral (all configuration is read at runtime).
  The three web images are not (below).

## Design

```
commit on main --(CI green)--> build-images.yml --> ghcr.io/<owner>/etickets-{api,worker}@sha256:...
                                                 \-> release-manifest.json (commit, version, time, digests)
release-manifest.json --promote-image.mjs--> QA  --(certify)--> UAT --(owner approval)--> PROD
rollback = promote-image.mjs with the PREVIOUS approved manifest
```

| Requirement                                    | How                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build immutable images in CI                   | `.github/workflows/build-images.yml` (manual): runs the CI gate, builds api + worker once, pushes by tag `sha-<commit>`, records the digest. Provenance (`mode=max`) and an SBOM are attached in the registry.                                                                                                                                    |
| Record digest, commit, build metadata, version | `release-manifest.json` artifact (90 days) + job summary. The image itself carries `GIT_SHA`, `BUILD_VERSION`, `BUILD_CREATED` (ENV + OCI labels).                                                                                                                                                                                                |
| Promote identical digests                      | `scripts/deploy/promote-image.mjs` sets the service source to `image@sha256:...` (never a tag) and redeploys.                                                                                                                                                                                                                                     |
| Secrets and configuration separate             | Images take only the three build-metadata arguments; every secret and setting stays a Railway variable per environment.                                                                                                                                                                                                                           |
| Deployment verification                        | `/api/health` now returns `build: { sha, version, builtAt, source }`; the script fails unless it reports the manifest's commit and `source: "image"`. `verify-deployed.mjs` still applies.                                                                                                                                                        |
| Approval gates                                 | PROD refuses without `CONFIRM_PROD_PROMOTE=<service>@<digest>` typed out. The token decides the environment and the script refuses a mismatch. GitHub environment reviewers would be the CI-side gate, but this repository's plan rejects protection rules (see deploy-railway.yml), so the gate is the owner running the PROD command.           |
| Rollback                                       | Promote the previous approved manifest (same command). Railway's `deploymentRollback` remains a fallback within its retention window.                                                                                                                                                                                                             |
| Backward-compatible migrations                 | `scripts/deploy/check-migration-compat.mjs`, run on every pull request in CI and as `npm run check:migrations`: a new migration that drops, renames, retypes or tightens something the previous release uses fails unless it carries a reviewed `-- migration-compat: <why>` line. History: 4 of 155 existing migrations would have been flagged. |

## Rollback validation

- Schema side, proven locally: the api image built from `main` (the release before the fee
  approval change, PR #585) booted and served the full two-replica drill against a database
  that already had #585's migration applied: 0 failed requests out of about 18,000. That is
  exactly the rollback case (old image, newer schema).
- Image side: promoting an older manifest is the same code path as promoting a new one; it
  has not been run against Railway yet (see the first-promotion checklist).

## Web apps: the build-time configuration problem

`NEXT_PUBLIC_*` values are inlined into the JavaScript bundle by `next build`:

- `NEXT_PUBLIC_API_URL` (web-kit's API client, every app; falls back to localhost),
- `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_ENV` (customer-web SEO, noindex headers, test banner),
- `NEXT_PUBLIC_ORGANIZER_URL`, `NEXT_PUBLIC_ADMIN_URL`, `NEXT_PUBLIC_STOREFRONT_URL`,
  `NEXT_PUBLIC_APP_RETURN_SCHEME`, `NEXT_PUBLIC_FEATURE_*`.

So a web image built for QA calls the QA API from production. Options, in order of preference:

1. **Runtime public config.** The root layout (a server component) reads plain runtime
   variables (`API_URL`, `SITE_URL`, `APP_ENV`...) and writes them into the page as
   `window.__ETG_CONFIG__`; web-kit and the few direct readers use that first and fall back to
   `NEXT_PUBLIC_*`. Server-side reads (`sitemap.ts`, `middleware.ts`, `next.config` headers)
   read the runtime variables directly. Cost: the root layout becomes dynamic, so pages that
   are prerendered today would render per request; the marketing pages need checking for
   SEO and speed. This is the real fix and needs its own PR with browser verification.
2. **Same-origin API.** Serve the API under each web app's own origin (`/api` rewrite), so
   the bundle needs only relative URLs. Removes the biggest variable, adds a hop.
3. **Build per environment from the same commit** (today), and record each environment's web
   digest in the manifest. Same source, not the same image. The fallback until 1 lands.

## First promotion on QA (needs the owner, not done)

1. Run `build-images.yml` on `main`. Download `release-manifest.json`.
2. GHCR packages are private by default: either make `etickets-api`/`etickets-worker` public
   (they contain no secret, but they do contain the full server code), or create a read-only
   GHCR token and pass it as `REGISTRY_USERNAME`/`REGISTRY_PASSWORD` to the script. Owner
   decision.
3. Dry run: `node scripts/deploy/promote-image.mjs --manifest release-manifest.json --env QA --service api`.
4. Apply on QA api, then check in the Railway dashboard that:
   - the `preDeployCommand` (`npx prisma migrate deploy`) still runs for an image source,
   - the health check and restart policy from `deploy/railway/api.railway.json` still apply,
     and the config file's `build` section does not force a rebuild from the repository,
   - `/api/health` reports `source: "image"` and the manifest commit.
5. Change one harmless QA variable and confirm the redeploy uses the same image (not `main`).
6. Promote the previous manifest to prove rollback, then the current one again.
7. Worker, then UAT, then production in the normal window.
