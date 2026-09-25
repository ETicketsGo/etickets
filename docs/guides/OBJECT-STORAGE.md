# Object storage (Cloudflare R2)

Posters, organization pictures and uploaded documents. Everything binary the platform holds
lives here once it is switched on, and in PostgreSQL until then.

**Nothing below changes behaviour until `OBJECT_STORE_DRIVER=r2` is set.** The default is the
database, which is what every environment runs today.

---

## What you need to do in Cloudflare

Fifteen minutes, once. You need a Cloudflare account; R2 needs a card on file even though the
free tier covers a pilot comfortably (10 GB stored, 1 million writes and 10 million reads a
month, and **no egress charge ever** — which is the reason we are not on S3).

### 1. Turn on R2

Cloudflare dashboard → **R2 Object Storage** → **Enable**. Add a payment method when asked.

### 2. Create TWO buckets

**R2 → Create bucket**, twice:

| Bucket                                              | Suggested name       | Public?       |
| --------------------------------------------------- | -------------------- | ------------- |
| Things customers see: posters, logos, cover banners | `eticketsgo-public`  | **Yes**       |
| Things only an admin sees: identity documents       | `eticketsgo-private` | **No, never** |

Location: **Asia-Pacific (APAC)** for an India launch. Leave the default storage class.

**Two buckets, not one with two folders.** R2 grants public access per _bucket_, so a single
bucket would have to be either wholly public or wholly private. An organizer's identity
document behind a guessable public URL is the one outcome this design makes impossible: the
code refuses to write a `private/` key to the public bucket, and vice versa.

Do this per environment as well — QA, UAT and production must not share buckets, or a test
poster can appear on a real event. So: `eticketsgo-qa-public`, `eticketsgo-qa-private`,
`eticketsgo-prod-public`, `eticketsgo-prod-private`, and so on.

### 3. Make the public bucket public

Open **`eticketsgo-public`** → **Settings** → **Public access**.

Either is fine:

- **Custom domain** (recommended): add `assets.eticketsgo.com`. Cloudflare creates the DNS
  record and the TLS certificate. This is the value for `R2_PUBLIC_BASE_URL`.
- **r2.dev subdomain**: click **Allow Access**. Cloudflare gives you a
  `https://pub-<hash>.r2.dev` address. Fine for QA; rate-limited and not meant for production.

Leave the private bucket's public access **disabled**. Check this twice.

### 4. Create an API token

**R2 → Manage R2 API Tokens → Create API token**.

- **Permissions**: `Object Read & Write`
- **Specify buckets**: apply to **only** the two buckets above — not "all buckets"
- **TTL**: forever, or your rotation period

Cloudflare then shows you three things **once**:

| Shown as                                                      | Goes into              |
| ------------------------------------------------------------- | ---------------------- |
| Access Key ID                                                 | `R2_ACCESS_KEY_ID`     |
| Secret Access Key                                             | `R2_SECRET_ACCESS_KEY` |
| Account ID (top-right of the R2 page, or in the endpoint URL) | `R2_ACCOUNT_ID`        |

Copy the secret before you close the dialog; it is not shown again.

### 5. Send me the values

Put them wherever you keep the Railway token — **not in a chat message, not in the repo**. I
need, per environment:

```
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_PUBLIC_BUCKET        e.g. eticketsgo-qa-public
R2_PRIVATE_BUCKET       e.g. eticketsgo-qa-private
R2_PUBLIC_BASE_URL      e.g. https://assets-qa.eticketsgo.com   (optional, see below)
```

### 6. CORS — only if you add a custom domain

R2 → the public bucket → **Settings → CORS policy**. Needed because the storefront fetches
images from a different origin than its own:

```json
[
  {
    "AllowedOrigins": ["https://eticketsgo.com", "https://qa.eticketsgo.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]
```

`GET` and `HEAD` only. The platform uploads through the API, never from a browser, so the
bucket never needs to accept a `PUT` from the public internet.

---

## What happens then

I set the variables and deploy. From that moment:

- **New uploads** go to the bucket.
- **Existing images keep working, untouched.** Each row records where its own bytes are, so a
  poster uploaded last week still reads from the database and one uploaded today reads from the
  bucket. The switch needs no migration and can be reverted by unsetting one variable.
- **Then the backfill runs** — `SEED_OPERATION=backfill-objects` — in batches, restartable, and
  safe to stop. It writes each object, reads it back to prove it arrived, and only then lets the
  row go of its bytes. A page renders half from each while it runs, and nobody notices.

### `R2_PUBLIC_BASE_URL` is optional, and worth doing second

Without it the API serves image bytes exactly as it does now: correct, and merely slower.

With it, the API stops proxying images entirely — it answers a poster request with a permanent
redirect to the CDN, and the browser goes straight to Cloudflare from then on. That is where the
speed and the bandwidth saving actually come from.

Getting the bytes out of the database is the urgent half; the custom domain can follow.

---

## The layout inside the bucket

Keys are built in one place (`apps/api/src/storage/object-keys.ts`), never at a call site:

```
public/events/<eventId>/<sha256>.<ext>
public/organizations/<organizationId>/<logo|cover>/<sha256>.<ext>
private/organizations/<organizationId>/identity/<documentId>.<ext>
```

Three things are deliberate:

- **Visibility first.** A bucket policy, lifecycle rule or cache rule can be written against a
  prefix, and a misfiled object is obvious from its key rather than buried in a config file.
- **Owner second.** Everything for one event or one organization is under a single prefix, so a
  deletion or an export is one call.
- **The content hash as the filename.** Replacing a picture writes a _different_ key, so no CDN,
  browser or proxy anywhere can be holding a stale answer at the new address. That is why the
  objects are served `immutable` with a one-year cache.

---

## Cost, for a pilot

A 400 KB poster, 5,000 events, 10 images each = about 20 GB stored. Reads are free.

|              | R2        | S3 + CloudFront |
| ------------ | --------- | --------------- |
| 20 GB stored | ~$0.30/mo | ~$0.46/mo       |
| 500 GB read  | **$0**    | ~$40/mo         |

The storage line is a rounding error either way. Egress is the whole bill, and it is the line
R2 does not have.

---

## Reverting

Set `OBJECT_STORE_DRIVER` back to `postgres`. New uploads go to the database again; rows already
pointing at the bucket keep reading from it, so **do not delete the buckets** after a revert —
those objects are the only copy. Moving them back would need the reverse of the backfill, which
is not written, because nobody has needed it.
