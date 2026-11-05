# Storefront SEO: indexability, canonicals, structured data

Owner: storefront (`apps/customer-web`). Branch `feat/seo-indexability`.

This file records what was wrong, what the code now does, and the manual steps that only a
person with the right accounts can do. Nothing below says that verification or indexing has
happened. Those steps are still to do.

## 1. Audit findings (read-only audit on origin/main 02bb21d4)

| ID    | Finding                                                                                                                                                                                                                           | Status in this branch                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1  | `app/[locale]/layout.tsx` set `alternates.canonical: '/'`. Every page without its own canonical (each event, each film, /events, /explore, /help, /login, /checkout, /shows) told search engines the home page was the real page. | Fixed. No root canonical. Each public page names itself, in its own language (`/fr-CA/...` for French), with `en`, `fr-CA` and `x-default` alternates, as the sitemap does.         |
| P0-2  | QA (qa.eticketsgo.com and customer-web-qa.up.railway.app) was fully indexable.                                                                                                                                                    | Fixed. Non-production: `Disallow: /`, empty sitemap, `X-Robots-Tag: noindex, nofollow` on every response, robots meta noindex.                                                      |
| P1-4  | No JSON-LD.                                                                                                                                                                                                                       | Added Organization + WebSite (with search) in `<head>`, and Event on event pages, built only from real data.                                                                        |
| P1-5  | Sitemap was static, listed noindex pages, and used `lastModified = now`.                                                                                                                                                          | Fixed. No noindex or private pages, no invented dates, published public events and films from the API, `revalidate = 3600`, empty outside production, survives API failure.         |
| P1-6  | Next 15 streams metadata into `<body>` for clients it does not recognise as bots.                                                                                                                                                 | Fixed with `htmlLimitedBots: /.*/` (present in the installed next 15.5.27).                                                                                                         |
| P1-7  | Fallback site URL was the apex `https://eticketsgo.com`.                                                                                                                                                                          | Fixed. One helper, `canonicalSiteUrl()`, falls back to `https://www.eticketsgo.com`.                                                                                                |
| P2-9  | Sharing cards on buyer pages carried the organizer pitch; no og:image.                                                                                                                                                            | Fixed. Buyer-facing defaults, per-page `og:url` and `og:locale`, a brand card at `/opengraph-image` and `/twitter-image`, the event's own picture on event pages.                   |
| P2-10 | Unknown events and films answered 200 (soft 404).                                                                                                                                                                                 | Fixed. A definite 404 from the API is a 404 page. A network error is not.                                                                                                           |
| P2-11 | Private routes were `index, follow`.                                                                                                                                                                                              | Fixed. Sign-in, register, password reset, account, checkout, seat choice, booking, invite and share pages say `noindex, nofollow`, and robots.txt disallows them in both languages. |

Also seen on production (read-only GETs, 2026-10-24):

- `https://www.eticketsgo.com/robots.txt` has a `Host:` line (Yandex only; removed in this branch).
- `HEAD http://eticketsgo.com/` answers 405, and `GET http://eticketsgo.com/events` answers 404:
  the GoDaddy forwarding on the apex does not keep the path. See section 5.
- The production public API returns no events or films today, so the production sitemap will
  list only the static pages until something is published.

## 2. How indexability is decided

One rule, in `apps/customer-web/lib/indexability.mjs`, used by `next.config.mjs`, the
middleware, robots.txt, the sitemap and the page metadata:

- Indexable only when `NEXT_PUBLIC_SITE_URL` has the host `www.eticketsgo.com` AND
  `NEXT_PUBLIC_APP_ENV` is empty or `PRODUCTION`.
- Anything else (QA, UAT, an unset or mistyped URL) is NOT indexable. This fails closed.
- Both are build arguments (see `apps/customer-web/Dockerfile`), so the answer is fixed per
  build. A change needs a rebuild, not only a variable change.
- `lib/indexability.test.ts` pins "production configuration is indexable". If that test is
  changed, production can drop out of Google.

In production, the middleware also sends `X-Robots-Tag: noindex` when a page is requested on a
public host that is not `www.eticketsgo.com` (for example the generated `*.up.railway.app`
host). It adds nothing for internal or unknown hosts (`localhost`, `*.internal`, IP addresses),
so a proxy that does not forward the public host cannot make the real site noindex.

Check after every production deploy (read-only):

```sh
node apps/customer-web/scripts/seo-check.mjs https://www.eticketsgo.com --expect indexable
node apps/customer-web/scripts/seo-check.mjs https://qa.eticketsgo.com --expect noindex
```

The production check must show no `X-Robots-Tag` on `https://www.eticketsgo.com/`. If it shows
one, roll back first and investigate second.

## 3. Google Search Console

Do these steps after this branch is deployed to production. Do not submit the sitemap before
then: the current production sitemap still lists noindex pages.

### 3.1 Domain property (preferred)

1. Sign in to https://search.google.com/search-console with the Google account that will own
   the property.
2. Select **Add property**, then **Domain**. Enter `eticketsgo.com` (no `https://`, no `www`).
3. Google shows a TXT record that starts with `google-site-verification=`. Copy it.
4. In GoDaddy: **My Products** > **Domains** > `eticketsgo.com` > **DNS** > **Add New Record**.
   - Type: `TXT`
   - Name: `@`
   - Value: the full `google-site-verification=...` string
   - TTL: default (1 hour)
     Save. Do not remove other TXT records (for example SPF or SES records).
5. Back in Search Console select **Verify**. DNS can take from minutes to a few hours. If it
   fails, wait and try again. You can check the record with
   `nslookup -type=TXT eticketsgo.com`.

A Domain property covers `www`, the apex, `http` and `https` together.

### 3.2 URL-prefix property (fallback)

Use this only if DNS cannot be changed.

1. **Add property** > **URL prefix** > `https://www.eticketsgo.com/`.
2. Choose the **HTML tag** method. Google gives a `<meta name="google-site-verification" ...>`
   tag. Adding it needs a small code change: set `verification: { google: '<token>' }` in the
   metadata in `apps/customer-web/app/[locale]/layout.tsx`, then deploy.
3. Select **Verify**.

### 3.3 Submit the sitemap

1. In the property, open **Indexing** > **Sitemaps**.
2. Enter `https://www.eticketsgo.com/sitemap.xml` (for a Domain property, enter the full URL)
   and select **Submit**.
3. Status should become **Success**. "Couldn't fetch" right after submitting is common; check
   again later.

### 3.4 Ask for the home page to be indexed

1. Paste `https://www.eticketsgo.com/` in the search bar at the top (**URL Inspection**).
2. Select **Test live URL**. Confirm "URL is available to Google", the canonical is
   `https://www.eticketsgo.com/`, and the page is indexable.
3. Select **Request indexing**.
4. Repeat for one or two important event pages once real events are published.

Indexing is Google's decision and can take days or weeks. A request does not guarantee it.

## 4. Bing Webmaster Tools

1. Sign in to https://www.bing.com/webmasters.
2. Easiest path: **Import from Google Search Console**. This needs the Search Console property
   from section 3 to be verified first. It imports the site and its sitemaps.
3. Without Google: **Add site** manually with `https://www.eticketsgo.com/`, then verify with
   either a DNS **CNAME** record in GoDaddy (Bing gives the name and value) or the XML file /
   meta tag method (needs a code change and deploy, like 3.2).
4. **Sitemaps** > **Submit sitemap** > `https://www.eticketsgo.com/sitemap.xml`.
5. Optional: IndexNow lets the site tell Bing (and Yandex) about new URLs immediately. It needs
   a key file served from the site and a call when an event is published. Not built; a
   follow-up if Bing traffic matters.

## 5. The apex domain (`eticketsgo.com`)

Today the apex is handled by GoDaddy forwarding. Measured on 2026-10-24: `HEAD` answers 405 and
`GET /events` answers 404, so the path is dropped. A shared link like
`eticketsgo.com/events/some-show` does not reach the event, and crawlers see errors.

Choose one:

- **Option A (recommended): point the apex at Railway** and have it answer every request with a
  `301` to `https://www.eticketsgo.com` plus the same path and query. Railway needs the apex as
  a custom domain on a service that does this redirect (a tiny redirect service, or the
  storefront itself with a host-based redirect added in the middleware). GoDaddy apex records
  cannot be CNAMEs, so this needs the record type Railway gives for apex domains (ALIAS/ANAME
  style or the A records it lists) or moving DNS to a provider that supports CNAME flattening.
- **Option B: GoDaddy forwarding with path.** In GoDaddy > Domain > **Forwarding**, forward
  `eticketsgo.com` to `https://www.eticketsgo.com` with **Permanent (301)** and **Forward with
  masking OFF**. GoDaddy's basic forwarding does not always keep the path; test afterwards with
  `curl -sI http://eticketsgo.com/events/test` and expect `301` with
  `Location: https://www.eticketsgo.com/events/test`. If the path is lost, use option A.

Until this is fixed, do not print or share apex links.

## 6. AI search crawlers

Production robots.txt allows every crawler under `User-agent: *`, which includes GPTBot,
OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot, Claude-SearchBot, Google-Extended and
Bingbot. Nothing blocks them, so public event pages can appear in AI search answers. To opt out
of one (for example model training by GPTBot while keeping OAI-SearchBot), add a separate rule
for that user agent in `apps/customer-web/lib/robots-rules.ts`. That is a business decision,
not made here.

These crawlers mostly do not run JavaScript. Event and film pages are client-rendered today, so
a crawler that does not run scripts sees the server-rendered metadata and JSON-LD but not the
page body. See the follow-ups.

## 7. What the code does now (reference)

- `lib/indexability.mjs`: the indexability rule and the `X-Robots-Tag` value per host.
- `lib/seo.ts`: home title and description, locale-aware canonical and alternates
  (`localizedPath`, `alternatesFor`, `localizedMetadata`), sharing cards (`shareCards`),
  `PRIVATE_ROBOTS`.
- `lib/structured-data.ts`: pure JSON-LD builders. Organization (name, url, logo, legal name
  from the entity registry, published support email), WebSite with SearchAction to
  `/events?q=` (the events page reads `q`), Event from `GET /public/events/:slug` only. No
  ratings, reviews, phone numbers or addresses that the API did not give. Offers only from
  ticket prices in one currency; availability only for general-admission sessions where the
  API reports a sale state and a count. `<` is escaped.
- `lib/sitemap-entries.ts` + `app/sitemap.ts`: static public pages, published upcoming events
  (`/public/events`, paged, capped at 1000) and bookable films (`/public/movies`), each with
  language alternates. Items the API labels DEMO or TEST are left out.
- `lib/robots-rules.ts` + `app/robots.ts`.
- `middleware.ts`: next-intl locale routing, unchanged, plus the `X-Robots-Tag` header.
- `next.config.mjs`: `htmlLimitedBots: /.*/` and the non-production `X-Robots-Tag`.
- `app/opengraph-image.tsx`, `app/twitter-image.tsx`: the brand sharing card, drawn at build
  time with the bundled font.
- `scripts/seo-check.mjs`: the read-only check in section 2.

## 8. Follow-ups (not in this branch)

- Render event and film pages on the server. They are client components, so the visible text
  (description, dates, prices) is not in the first HTML a crawler receives. The metadata and
  JSON-LD are.
- Movie JSON-LD (schema.org `Movie` plus `ScreeningEvent` per show) on film pages.
- Event offers show the ticket's face price. When fees are added at checkout
  (`feeMode = CUSTOMER_PAYS`) or GST applies, the search result price can be lower than the
  checkout total. Consider using the advertised all-in price once the API returns it on the
  detail endpoint.
- `/privacy` and `/delete-account` still declare the English path as canonical for French
  pages. Those files are owned by another PR; apply `localizedMetadata` there when it merges.
- The Dockerfile's `NEXT_PUBLIC_SITE_URL` default is the apex. Left on purpose: a build that
  forgets the argument is then not indexable (fail closed), instead of a QA build becoming
  indexable.
- IndexNow (section 4).
