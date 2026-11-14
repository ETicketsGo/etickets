# Off-platform backup copy

Status: **OFF until the owner sets the variables below**. The chosen store is Cloudflare R2 (see
"Cloudflare R2"). Nothing here changes how the local nightly backup works (`apps/api/prisma/backup.ts`).

## What it does

The nightly `db-seed` run (`SEED_OPERATION` unset, falling back to `backup`) already takes a `pg_dump`, verifies it
with `pg_restore --list` and keeps the last N on the Railway volume. With `BACKUP_OFFSITE_BUCKET` set it then makes
one more copy in S3-compatible storage that is outside Railway:

1. Only after the local dump verified. A dump that failed verification is never uploaded.
2. SHA-256 of the file is computed locally and sent as the object checksum (`x-amz-checksum-sha256`). The store
   recomputes it over the bytes it received and refuses the upload on a mismatch. The hex digest is also kept in the
   object metadata (`sha256`, `source-bytes`, `source-name`).
3. Server-side encryption is requested: SSE-S3 (`AES256`) by default, SSE-KMS when `BACKUP_OFFSITE_KMS_KEY_ID` is set.
4. The key is unique per run: `<prefix>/<app-env>/<UTC date>/etg-<app-env>-<timestamp>.dump`. The request also carries
   `If-None-Match: *`, so even a re-run cannot replace an object. The code never deletes or overwrites remote
   objects.
5. On success it writes an `AuditLog` evidence row (`BACKUP_OFFSITE_UPLOADED`) so the API can report the age of the
   off-platform copy. `BACKUP_JSON` gains `offsite: {status, key, sha256, bytes}`.

### If the upload fails

The local verified dump is never touched: it is not deleted, renamed or marked bad. The run logs
`ERROR BACKUP_OFFSITE_FAILED ...` (stable code, no URLs or key ids), `BACKUP_JSON` shows `offsite.status: "failed"`,
and the run itself still completes with exit code 0, because the local backup succeeded. The failure becomes visible
through the freshness signal (below) and the log line, not through a failed deployment. A transient error (5xx, 429,
timeout) is retried twice; a permanent one (403, 400 BadDigest, missing bucket) is not.

### Freshness signal

`GET /api/ops/health` (field `backup`) gains an optional `offsite` object only when the **API service** also has
`BACKUP_OFFSITE_BUCKET` set (the value is a bucket name, not a secret). With it unset the field is absent and the
health result is exactly as before.

- `offsite.status`: `fresh` (newest accepted upload is within 26 h, or `BACKUP_OFFSITE_MAX_AGE_HOURS`), `stale`,
  `never`, `unknown` (evidence could not be read).
- Overall health becomes `degraded` when a configured copy is `stale`, in any environment. `never` degrades only where
  backups are required (APP_ENV PRODUCTION or `BACKUP_FRESHNESS_REQUIRED=true`), so the first night after enabling it
  does not page anyone in QA.

## Variables (names only; set them on `db-seed`, and `BACKUP_OFFSITE_BUCKET` also on `api`)

| Name                                                               | Where        | Meaning                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_OFFSITE_BUCKET`                                            | db-seed, api | Turns the feature on. Unset means off.                                                                                                                              |
| `BACKUP_OFFSITE_REGION`                                            | db-seed      | Default `auto` for an R2 endpoint (R2 refuses AWS region names with 400 `InvalidRegionName`), otherwise `AWS_REGION` or `ap-south-1`.                               |
| `BACKUP_OFFSITE_PREFIX`                                            | db-seed      | Default `etg-db-backups`.                                                                                                                                           |
| `BACKUP_OFFSITE_ENDPOINT`                                          | db-seed      | For R2/B2/other S3-compatible stores (path-style addressing is used when set). Only the origin is used; a pasted bucket URL is reduced to the account endpoint.     |
| `BACKUP_OFFSITE_SSE`                                               | db-seed      | Optional: `none` for a store that rejects SSE headers. `aws:kms` is implied by the key id.                                                                          |
| `BACKUP_OFFSITE_KMS_KEY_ID`                                        | db-seed      | Optional KMS key for SSE-KMS.                                                                                                                                       |
| `BACKUP_OFFSITE_ENCRYPTION_KEY`                                    | db-seed      | 32 random bytes (base64). Client-side AES-256-GCM before upload. **Required when APP_ENV is PRODUCTION/STAGING** (no key = no upload). Keep a copy OUTSIDE Railway. |
| `BACKUP_OFFSITE_MAX_AGE_HOURS`                                     | api          | Optional, default 26.                                                                                                                                               |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_SESSION_TOKEN`) | db-seed      | The **write-only** principal below. Standard AWS names; never set the read principal here.                                                                          |

## Cloudflare R2 (the chosen store)

Proven against the real bucket `eticketsgo-recovery` on 2026-11-14:

- **Works as-is:** SHA-256 checksum (a wrong one is refused with 400 `BadDigest`), `If-None-Match: *` (a second write of a key is refused with 412, reported as `exists`), custom metadata, and the `AES256` SSE header (accepted; R2 always encrypts at rest).
- **Needed a code change:** the region must be `auto`. This is now the default for any `*.r2.cloudflarestorage.com` endpoint, and `AWS_REGION` is never inherited for R2.
- **R2 has no write-only credential.** "Object Read & Write" can also delete. The bucket lock rule below is what stops a leaked key from destroying history, so **it is required, not optional**.
- **Object keys:** `etg-db-backups/production/<date>/…dump.enc` and `etg-db-backups/qa/<date>/…dump.enc`.

### Owner steps (Cloudflare dashboard → R2 → `eticketsgo-recovery`)

1. **Settings → Public access:** the r2.dev URL is **Disabled** and there are **no custom domains**. The S3 endpoint always requires a signature.
2. **Settings → Bucket lock rules → Add rule:**
   - name `retain-35d`
   - prefix `etg-db-backups/`
   - condition: age **35 days**

   Objects under the prefix then cannot be deleted or overwritten for 35 days, by anyone, including with these keys.

3. **Settings → Object lifecycle rules → Add rule:**
   - name `expire-36d`
   - prefix `etg-db-backups/`
   - delete objects after **36 days**
   - abort incomplete multipart uploads after **1 day**

   The lifecycle rule must be **longer** than the lock (36 > 35) so the two never conflict.

4. **R2 → Manage API tokens:** create **one token per job**, each scoped to **this bucket only**:

   | Token                    | Permission          | Where it lives                                       |
   | ------------------------ | ------------------- | ---------------------------------------------------- |
   | `etg-backup-writer-prod` | Object Read & Write | PROD `db-seed` only                                  |
   | `etg-backup-writer-qa`   | Object Read & Write | QA `db-seed` only                                    |
   | `etg-backup-reader`      | Object Read only    | The owner's password manager, used only for restores |

   Never Admin. The token used for the 2026-11-14 rehearsal can become the QA writer.

5. **Encryption keys:** one per environment, each 32 random bytes in base64. Store the PROD key in the password manager **before** setting it on Railway. A key that exists only in Railway is lost in exactly the disaster this copy is for.

### Railway variables (db-seed; `BACKUP_OFFSITE_BUCKET` also on api)

`BACKUP_OFFSITE_BUCKET=eticketsgo-recovery`, `BACKUP_OFFSITE_ENDPOINT=https://<account id>.r2.cloudflarestorage.com`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (that environment's writer token), `BACKUP_OFFSITE_ENCRYPTION_KEY`. Leave `BACKUP_OFFSITE_REGION`, `BACKUP_OFFSITE_SSE` and `BACKUP_OFFSITE_PREFIX` unset. The api needs only the bucket name, because it reads the evidence row and never calls R2.

### Restore drill from outside Railway (no local Postgres install needed)

Use the **reader** token and the key from the password manager, in your own shell, with Docker:

```bash
docker network create etg-drill
docker run -d --name etg-drill-pg --network etg-drill -e POSTGRES_PASSWORD=<pw> -e POSTGRES_DB=etg_restore_drill postgres:16
# from apps/api, with the variables above plus AWS_* = reader token, DRILL_ENV=production|qa, and
# RESTORE_DRILL_DATABASE_URL=postgresql://postgres:<pw>@etg-drill-pg:5432/etg_restore_drill
docker run --rm --network etg-drill -v "$PWD/prisma:/drill/prisma" -w /drill \
  -e BACKUP_OFFSITE_BUCKET -e BACKUP_OFFSITE_ENDPOINT -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  -e BACKUP_OFFSITE_ENCRYPTION_KEY -e DRILL_ENV -e RESTORE_DRILL_DATABASE_URL node:24-alpine sh -c \
  "apk add --no-cache postgresql16-client && npm i @aws-sdk/client-s3 ts-node typescript @types/node && \
   npx ts-node --transpile-only --compiler-options '{\"module\":\"commonjs\",\"moduleResolution\":\"node\"}' prisma/offsite-restore-drill.ts"
docker rm -f etg-drill-pg && docker network rm etg-drill
```

`OFFSITE_RESTORE_DRILL_JSON {"ok":true,…}` with row counts is the pass.

**QA rehearsal, 2026-11-14:**

- The QA dump (3.77 MB) was encrypted and uploaded by the real dispatcher (`backup` operation).
- R2 verified the checksum.
- Downloaded, verified, decrypted and restored in a local container in 8 s.
- All 141 tables, the migration count and the payment, refund and booking totals and hashes were identical to live QA. The one difference was the 2 evidence rows the run wrote after the dump.

### Cost

- Storage costs $0.015 per GB-month, and the first 10 GB a month are free.
- Class A operations (writes) cost $4.50 per million; class B (reads) cost $0.36 per million.
- Egress is free.

36 nightly PROD dumps of about 0.6 MB plus QA come to well under 1 GB and fewer than 100 writes a month, so the cost is **$0** inside the free tier.

## Owner steps (alternative: AWS S3)

1. Create a bucket in `ap-south-1`, in an AWS account that is **not** the one that holds Railway/GoDaddy access.
2. Turn on **Block all public access**.
3. Turn on **versioning** and either **Object Lock** (compliance or governance mode, e.g. 30 days) or at minimum a
   lifecycle rule. Object Lock is what makes a stolen write credential unable to destroy history.
4. Retention is the bucket's lifecycle rule (the code never deletes remote objects). Suggested: expire current
   versions after 35 days, non-current versions after 7 days, and abort incomplete multipart uploads after 1 day.
5. Create an IAM user (or role) used only by the backup job, with this policy (replace the bucket and prefix):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "WriteBackupsOnly",
         "Effect": "Allow",
         "Action": ["s3:PutObject"],
         "Resource": "arn:aws:s3:::BUCKET/etg-db-backups/*"
       }
     ]
   }
   ```

   No `GetObject`, `ListBucket`, `DeleteObject` or `PutObjectAcl`. If you use SSE-KMS add `kms:GenerateDataKey` on that
   key. `If-None-Match` on PutObject needs only `s3:PutObject`.

6. Create a **separate read principal** (`s3:GetObject`, `s3:ListBucket` on the prefix, plus `kms:Decrypt` if KMS) held by
   the owner, outside Railway. It is used only for restores.
7. Set the variables above on `db-seed` (and `BACKUP_OFFSITE_BUCKET` on `api`). Do not set `SEED_OPERATION`.

## Verify after the first nightly run

1. In the 02:00 UTC `db-seed` log find `BACKUP_JSON` and check `offsite.status` is `uploaded`, and copy `offsite.key`
   and `offsite.sha256`. (Search the log for `BACKUP_OFFSITE_FAILED` if not.)
2. With the **read** principal: `aws s3api head-object --bucket BUCKET --key KEY` and confirm
   `ServerSideEncryption`, `ChecksumSHA256` (base64 of the same digest) and `Metadata.sha256`.
3. `GET /api/ops/health` shows `backup.offsite.status: "fresh"`.

## Restore from the off-platform copy into an isolated database

Never restore over the live database. Use a scratch Postgres (local or a throwaway Railway service) that has no
connection to production.

```bash
# 1. Fetch with the READ principal (credentials in your own shell, not Railway).
aws s3 cp "s3://BUCKET/KEY" ./restore.dump --region ap-south-1

# 2. Check integrity against the digest recorded in BACKUP_JSON / object metadata.
sha256sum restore.dump          # must equal offsite.sha256

# 3. Read the archive, then restore into a new empty database.
pg_restore --list restore.dump > /dev/null
createdb etg_restore_check
pg_restore --no-owner --no-acl --dbname etg_restore_check restore.dump

# 4. Count rows (the same tables the nightly restore drill counts).
psql etg_restore_check -c 'SELECT count(*) FROM "User"' -c 'SELECT count(*) FROM "Booking"'
```

Then follow `docs/ops/BACKUP-RUNBOOK.md` for pointing a non-production stack at it. Record the date and the measured
time in the restore log.

## Limits to know

- One `PutObject` carries at most 5 GB. The compressed dump is far below that for the pilot; if it ever approaches it,
  switch to multipart upload (needs `@aws-sdk/lib-storage`, deliberately not added now).
- The upload is not part of the destructive `full-reset` path, which only needs the local pre-reset recovery point.
- This is tested against a mocked client and an in-process S3-compatible HTTP server. It has **not** been run against
  real AWS S3; the first real run is the owner's verification above.

## Client-side encryption and the off-platform restore drill

Server-side encryption protects the provider's disks, not the data from whoever holds bucket credentials. With
`BACKUP_OFFSITE_ENCRYPTION_KEY` set, the dump is encrypted on db-seed before upload (`prisma/backup-crypto.ts`,
AES-256-GCM, fresh IV per file, authenticated) and stored as `<name>.dump.enc` with metadata `encryption`, `key-fp`
(key fingerprint, not the key) and `source-sha256`. Production refuses to upload without a key.

Generate the key once: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Store it in
the password manager FIRST, then set it on db-seed. A key that exists only in Railway is lost in exactly the disaster
this copy is for. To rotate, set a new key; older objects stay decryptable with the old key (the fingerprint says
which one a file needs).

**Restore drill from outside Railway** (`prisma/offsite-restore-drill.ts`) with the READ-only principal: newest object
for the environment -> SHA-256 check -> decrypt -> `pg_restore --list` -> optional restore into an EMPTY scratch
database (`RESTORE_DRILL_DATABASE_URL`; refuses a database that already has tables) -> core-table row counts. Needs
Node and the Postgres 16 client tools. Prints one `OFFSITE_RESTORE_DRILL_JSON` line, deletes every temporary file.
