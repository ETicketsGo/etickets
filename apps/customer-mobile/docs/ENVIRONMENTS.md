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

## Live QA (verified 2026-08-04)

| Service         | Host                                     | State                                 |
| --------------- | ---------------------------------------- | ------------------------------------- |
| API             | `https://api-qa-f580.up.railway.app/api` | **Working** — use this                |
| Customer web    | `https://qa.eticketsgo.com`              | Live, cert valid                      |
| API (preferred) | `https://api-qa.eticketsgo.com`          | **NXDOMAIN** — CNAME not at registrar |
| Organizer web   | `https://organizer-qa.eticketsgo.com`    | NXDOMAIN                              |
| Admin web       | `https://admin-qa.eticketsgo.com`        | NXDOMAIN                              |

QA posture: `PAYMENT_PROVIDER_NAME=mock`, all money automation off, Swagger enabled,
app-sleeping on (so the first request after idle pays a cold start).

### Switching to `api-qa.eticketsgo.com`

Do **not** switch until all four verify. The Railway hostname works today; a bundle
pointed at a name that does not resolve is bricked until DNS propagates.

```bash
# 1. DNS resolves
nslookup api-qa.eticketsgo.com          # must not say "Non-existent domain"

# 2. TLS issued (Railway needs the CNAME present first)
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' \
  https://api-qa.eticketsgo.com/api/health

# 3. Health responds
curl -sS https://api-qa.eticketsgo.com/api/health     # {"status":"ok",...}

# 4. CORS allows the customer origin
curl -sS -X OPTIONS https://api-qa.eticketsgo.com/api/public/discovery \
  -H 'Origin: https://qa.eticketsgo.com' \
  -H 'Access-Control-Request-Method: GET' -D - -o /dev/null | grep -i allow-origin
```

The CNAME still missing at the registrar: `api-qa` → `ktndx6oh.up.railway.app`.

Then set `EXPO_PUBLIC_API_URL` in `eas.json`'s `qa` profile and rebuild. No code change.

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
