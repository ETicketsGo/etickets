# Environments

## Configuration is centralised and override-driven

One path, no exceptions:

```
EXPO_PUBLIC_* env var  →  app.config.ts `extra`  →  src/services/env.ts (typed)  →  app
```

Nothing reads `process.env` directly outside `app.config.ts`. **Changing a hostname
never requires a code change** — set the variable, rebuild.

`env.ts` reads `extra` through a string guard. That is not decoration: `app.config.ts`
writes `?? null` and Expo's serialisation turns `null` into `{}`, which is truthy. Read
naively, `env.webHost` becomes an object and `webHost.toLowerCase()` throws.

## Variables

| Variable                 | Required       | Notes                                      |
| ------------------------ | -------------- | ------------------------------------------ |
| `EXPO_PUBLIC_API_URL`    | yes            | Include the `/api` prefix                  |
| `EXPO_PUBLIC_WEB_HOST`   | for deep links | Also the https deep-link host allow-list   |
| `EXPO_PUBLIC_ENV`        | yes            | `development` \| `staging` \| `production` |
| `EXPO_PUBLIC_SENTRY_DSN` | no             | Public write-only DSN                      |

In a `production` build, `env.ts` throws rather than start with a missing or localhost
API URL. A prod build pointing at a dev API is a release defect, not a fallback.

## Live QA (verified 2026-08-06)

Every service is reachable on its eticketsgo.com name, with a Railway-issued certificate.

| Service       | Host                                  | State                             |
| ------------- | ------------------------------------- | --------------------------------- |
| API           | `https://api-qa.eticketsgo.com/api`   | **Live** — this is the one to use |
| Customer web  | `https://qa.eticketsgo.com`           | Live                              |
| Organizer web | `https://organizer-qa.eticketsgo.com` | Live                              |
| Admin web     | `https://admin-qa.eticketsgo.com`     | Live                              |

All four: DNS matches the required CNAME, `certificateStatus: VALID`, and the API answers
`/api/health` and `/api/ready` with 200 and CORS for all three web origins.

### Do not go back to the generated hostname

`api-qa-f580.up.railway.app` still works, and everything pointed at it until 2026-08-06,
but it is **not stable across service re-creation**. It has already changed once —
`api-qa-f23c` → `api-qa-f580` — and because these values are inlined at BUILD time,
every consumer baked against the old one broke and needed a rebuild rather than a restart.

That is worse for a native app than for the web: an APK cannot be repointed at all
without shipping a new binary. The mobile `qa` EAS profile therefore uses the custom
domain, and did so before the first build was ever produced.

Override with `EXPO_PUBLIC_API_URL` (mobile) or `QA_API_HOST` (deploy script) if a
hostname ever needs to change again — neither requires a code edit.

### The checklist that was used before switching

Kept because the same four conditions apply to UAT and production when their domains are
provisioned. Do not repoint a build until all four pass.

```bash
# 1. DNS resolves, and to the CNAME Railway asked for
nslookup api-qa.eticketsgo.com

# 2. TLS verifies (0 = valid chain)
curl -sS -o /dev/null -w '%{http_code} tls=%{ssl_verify_result}\n' \
  https://api-qa.eticketsgo.com/api/health

# 3. The app is actually up behind it
curl -sS https://api-qa.eticketsgo.com/api/ready

# 4. CORS answers the browser origin that will call it
curl -sS -X OPTIONS https://api-qa.eticketsgo.com/api/public/discovery \
  -H 'Origin: https://qa.eticketsgo.com' \
  -H 'Access-Control-Request-Method: GET' -D - -o /dev/null | grep -i allow-origin
```

## EAS profiles

| Profile                 | `EXPO_PUBLIC_ENV` | API                                            | Distribution    |
| ----------------------- | ----------------- | ---------------------------------------------- | --------------- |
| `development`           | development       | `http://10.0.2.2:4000/api`                     | dev client, APK |
| `development-simulator` | development       | same                                           | iOS simulator   |
| `qa`                    | staging           | QA Railway host                                | internal, APK   |
| `preview`               | staging           | `api-uat.eticketsgo.com` — **not provisioned** | internal, APK   |
| `production`            | production        | `api.eticketsgo.com` — **not provisioned**     | AAB             |

`preview` and `production` hostnames are the intended names from the deployment plan.
Neither environment exists yet; both must be verified before those profiles are used.
