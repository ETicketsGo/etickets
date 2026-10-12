# Off-platform backup copy

Status: **OFF until the owner sets the variables below**. Nothing here changes how the local
nightly backup works (`apps/api/prisma/backup.ts`).

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

| Name                                                               | Where        | Meaning                                                                                    |
| ------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------ |
| `BACKUP_OFFSITE_BUCKET`                                            | db-seed, api | Turns the feature on. Unset means off.                                                     |
| `BACKUP_OFFSITE_REGION`                                            | db-seed      | Default `ap-south-1` (Mumbai).                                                             |
| `BACKUP_OFFSITE_PREFIX`                                            | db-seed      | Default `etg-db-backups`.                                                                  |
| `BACKUP_OFFSITE_ENDPOINT`                                          | db-seed      | Optional, for R2/B2/other S3-compatible stores (path-style addressing is used when set).   |
| `BACKUP_OFFSITE_SSE`                                               | db-seed      | Optional: `none` for a store that rejects SSE headers. `aws:kms` is implied by the key id. |
| `BACKUP_OFFSITE_KMS_KEY_ID`                                        | db-seed      | Optional KMS key for SSE-KMS.                                                              |
| `BACKUP_OFFSITE_MAX_AGE_HOURS`                                     | api          | Optional, default 26.                                                                      |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_SESSION_TOKEN`) | db-seed      | The **write-only** principal below. Standard AWS names; never set the read principal here. |

## Owner steps

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
