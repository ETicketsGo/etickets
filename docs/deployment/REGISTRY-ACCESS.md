# Private image registry: minimum access for Railway (2026-11-06)

Owner decision item 6: **the registry stays private.** `build-images.yml` (#589) pushes
`ghcr.io/eticketsgo/etickets-api` and `-worker` to GitHub Container Registry. New GHCR packages
are private by default. Nothing here was created or changed; these are the owner's steps.

## The one credential Railway needs: pull, nothing else

| Item               | Minimum                                                                                                                                              | Why not more                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Identity           | A dedicated **machine user** (for example `etg-registry-reader`), not a person's account                                                             | Survives staff changes; can be revoked alone                                                                                             |
| Package access     | On each package (`etickets-api`, `etickets-worker`): Package settings -> Manage access -> add the machine user with role **Read**                    | Read is pull only; Write/Admin could push or delete images                                                                               |
| Token              | **Classic** personal access token of the machine user, scope **`read:packages` only**, with an expiry (90 days)                                      | GHCR does not accept fine-grained tokens for pulls; no `repo`, no `write:packages`, no `delete:packages`                                 |
| Where it is stored | Railway -> each environment -> `api` and `worker` -> Settings -> Source -> Image -> Registry credentials (username = machine user, password = token) | Set per environment, so a QA token cannot be reused for production. One token per environment makes rotation and revocation independent. |
| Who can see it     | Railway project members with access to that environment                                                                                              | Railway project tokens used by CI are environment-scoped (verified for QA).                                                              |

**The workflow itself needs no extra secret.** It pushes with the job's `GITHUB_TOKEN`
(`packages: write` on that job only), which expires when the job ends.

## What not to do

- Do not make the packages public. The images carry the compiled API and worker and their
  dependency tree. They hold no secrets (none are baked in; checked in #589), but they are
  still the product.
- Do not use an owner's personal token or a token with `repo` scope.
- Do not share one token between QA, UAT and production.

## Rotation

Create the new token, update the Railway registry credential (a service setting, not a variable,
so it does not redeploy), pull-test with a redeploy of the same image digest, then revoke the
old token.

## Status

Blocked on the owner (AR-20): machine user, package access and three tokens. Until then
`promote-image.mjs` stays in dry-run, and QA keeps building from source.
