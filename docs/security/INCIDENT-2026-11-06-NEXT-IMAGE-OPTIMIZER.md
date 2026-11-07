# Security incident 2026-11-06: Next.js image optimizer advisory (GHSA-2464-fhr4-w9xw)

**Status: REMEDIATED in production 2026-11-06 23:52 UTC.** No indicator of compromise found.
Owner-approved emergency release, limited to the three web apps.

## 1. The advisory

|            |                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| ID         | GHSA-2464-fhr4-w9xw (critical), published 2026-10-22                                                      |
| Title      | Next.js: Unauthenticated Remote Code Execution in Image Optimization API when SVG files are used          |
| Affected   | `next` >= 10.0.0, <= 15.5.27 (and 16.0.0-16.4.0)                                                          |
| Fixed      | `next` 15.5.28 (16.4.1)                                                                                   |
| Root cause | a memory bug in the upstream image library (sharp / libvips) "when Next.js runs on **glibc-based Linux**" |
| Workaround | sharp >= 0.35.5                                                                                           |

Fixed by the same release: GHSA-p3m5-59mp-jv5r (high), Denial of Service in App Router using
Server Actions, `next` <= 15.5.27.

## 2. What production actually ran (read inside the running containers over SSH)

| Service       | Domain                   | Commit     | next        | sharp / libvips             | OS / libc              | Node    |
| ------------- | ------------------------ | ---------- | ----------- | --------------------------- | ---------------------- | ------- |
| customer-web  | www.eticketsgo.com       | `be2a2c7f` | **15.5.27** | 0.35.5 / 1.3.4 (musl build) | Alpine 3.23 / **musl** | 20.20.2 |
| organizer-web | organizer.eticketsgo.com | `646e469f` | **15.5.27** | 0.35.5 / 1.3.4 (musl build) | Alpine 3.23 / **musl** | 20.20.2 |
| admin-web     | admin.eticketsgo.com     | `646e469f` | **15.5.27** | 0.35.5 / 1.3.4 (musl build) | Alpine 3.23 / **musl** | 20.20.2 |

`/_next/image` answered 200 on all three, although no app imports `next/image`.

**Assessment.** The RCE as published needs glibc Linux and sharp < 0.35.5. Production ran
musl with sharp 0.35.5, so the RCE was most likely **not exploitable**. `next` 15.5.27 was still
inside the advisory's range (scanners flag it) and was exposed to the Server Actions DoS
(GHSA-p3m5). The upgrade was right either way.

## 3. Evidence review (read-only, no exploitation attempted)

- **HTTP logs**, 60 web deployments, 2026-10-07 to 2026-11-06: 46,086 requests, **0 responses
  with 5xx**, **3 requests to `/_next/image`** (all the safe favicon check made during this
  investigation), **no SVG and no external image source**.
- **Runtime logs**: no crash, memory fault or process error before the investigation. The only
  errors are `EACCES ... mkdir .next/cache` (see AR-41) and Server Action probes (below).
- **Containers**: one process each (`next-server`, PID 1, up since its deploy), no files in
  `/tmp`, `/var/tmp`, `/dev/shm`, no application file newer than the server outside the cache.
- **Server Action probing (reconnaissance, not compromise).** Since at least 2026-10-08,
  internet scanners send Server Action requests with junk ids (`x`, `y`, `r2s`, `cachefn`, random
  hashes) to all three apps, most to admin-web (26 since 2026-11-05). Every one was refused before
  any action ran ("Server Reference ID did not match the expected format") with 403/404; none
  produced a 5xx. Sources are many cloud addresses (e.g. 91.196.152.x, 195.184.76.x,
  104.248.167.254, 34.107.83.91, 102.220.161.89), user agents include `l9scan`.

No credential rotation is indicated by this evidence.

## 4. The fix and how it was isolated

- PR **#596** (`2fe461ea`): `next` 15.5.27 -> **15.5.28**, pinned exactly (a caret range would
  resolve 15.5.29, published 2026-11-03). Merged to `main` as `488bd470`.
- Production runs TWO revisions, and shared packages differ between them, so one hotfix per
  revision (cherry-pick of `2fe461ea`, clean):

| Branch                                 | Base (PROD) | Hotfix commit                              | Used for                 |
| -------------------------------------- | ----------- | ------------------------------------------ | ------------------------ |
| `release/hotfix-next-15.5.28-be2a2c7f` | `be2a2c7f`  | `21ed58abaa7c6707613433f921cd026cfd7e3a70` | customer-web             |
| `release/hotfix-next-15.5.28-646e469f` | `646e469f`  | `e7285c1932b8a0a916f7bcf6da875bc04d790d2e` | organizer-web, admin-web |

- Each hotfix changes 5 files (four `package.json` + `package-lock.json`). Every resolved package
  in the lockfile was compared with its base: only `next`, `@next/env` and the `@next/swc-*`
  binaries move (15.5.27 -> 15.5.28). sharp stays 0.35.5. Node 20, the Dockerfiles, the legacy
  Railway config files, the API, worker, schema and payment code are untouched.
- Full CI on the exact hotfix commits (push to `release/**`): runs `42309445798` and
  `42309458797`, both **success**.

## 5. Production deployment (2026-11-06, UTC)

Deployed with `C:\etg-wt\prod-deploy-kit\deploy-hotfix.mjs` (kit guards + PROD confirmation; it
refuses any service but the web apps, any commit whose parent is not the commit that service
runs, and any change outside the five dependency files; refusal paths tested first).

| Service       | New deployment                         | Commit     | Build | SUCCESS at | Rollback target (vulnerable)                        |
| ------------- | -------------------------------------- | ---------- | ----- | ---------- | --------------------------------------------------- |
| customer-web  | `ee2efcfb-ec03-4e4f-8abd-8f640aafd9b5` | `21ed58ab` | 183 s | 23:42:07   | `b7552adc-8c84-4818-b16f-9fb86619b1d3` (`be2a2c7f`) |
| organizer-web | `c7f8e6ff-9700-4d2c-975a-213575394427` | `e7285c19` | 183 s | 23:46:18   | `c4765723-5896-4d09-ad24-759d573373d5` (`646e469f`) |
| admin-web     | `fddf9bad-a754-4aeb-b1b7-6999d2ffff0b` | `e7285c19` | 274 s | 23:52:07   | `b801db87-7216-401a-b6cb-54c2dce15404` (`646e469f`) |

Each new deployment uses the same config file, Dockerfile, start command and health check as
before. **Not deployed:** api (`292c6070`), worker (`9170e7e8`), db-seed, Postgres, Redis. No
variable, secret, replica, fee, payment or database change. No IaC applied. The latest verified
backup before the release: `etg-production-2026-11-06T02-00-26-066Z.dump` (14 kept).

**Rollback** re-introduces the vulnerable version; prefer a corrected hotfix. If unavoidable:
`deploymentRollback(<target above>)` per service.

## 6. Verification after the release

- Inside each container: `next` **15.5.28**, sharp 0.35.5, Node 20.20.2, musl.
- Health: all three 200 (customer-web reports build `21ed58a`).
- Public pages (storefront home, events, movies, sign-in, register, account redirect;
  organizer home, sign-in, start, dashboard, events, finance; admin home, sign-in, console):
  **identical to the pre-release baseline**, every referenced JavaScript chunk loads.
- Image optimizer, safe local request (`/_next/image?url=/favicon.ico`): 200 `image/x-icon` on
  all three.
- Checkout and payment initialisation could not be exercised end to end: production lists 0
  public events, and creating one is outside this authorisation. The API, which owns checkout and
  payments, was not redeployed.

## 7. Remaining exposure and follow-ups

- **AR-41** the runtime user cannot write `.next/cache` (image and page cache never persist;
  every request re-renders). Fix in the Dockerfiles (create the directory owned by the runtime
  user).
- **AR-42** Server Action probing is constant and heaviest on admin-web, which answers anonymous
  requests (AR-34). Put Cloudflare Access (or equivalent) in front of `admin.eticketsgo.com`.
- `next` 15.5.29 exists (2026-11-03); take it in the normal release after two weeks.
- UAT runs `next` 15.5.27 (`2439e254`) and was not changed (not in scope).
