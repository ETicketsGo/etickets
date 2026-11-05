#!/usr/bin/env node
/**
 * Read-only SEO check of a running storefront. GET requests only; it changes nothing.
 *
 *   node scripts/seo-check.mjs <base-url> --expect indexable|noindex [--event <slug>]
 *
 *   node scripts/seo-check.mjs https://www.eticketsgo.com --expect indexable
 *   node scripts/seo-check.mjs https://qa.eticketsgo.com --expect noindex
 *   node scripts/seo-check.mjs http://localhost:3107 --expect noindex --event some-event-slug
 *
 * Checks robots.txt, the sitemap (well-formed, every <loc> on the site's host), the home
 * page's title, description, canonical and robots meta INSIDE <head>, the X-Robots-Tag
 * header, and that every JSON-LD block parses. With --event it also checks that the event
 * page names itself as canonical and carries Event JSON-LD.
 *
 * Exit code 0 when every check passes, 1 when any fails, 2 for bad arguments. A failing
 * check is printed with what was expected and what was found.
 *
 * For a local server the canonical host is the CONFIGURED site URL, not localhost, so the
 * host comparison uses the host the pages themselves declare (their canonical link).
 */

const HOME_TITLE = 'ETicketsGo | Discover & Book Movies, Events and Experiences';
const HOME_DESCRIPTION =
  'Discover and book tickets for movies, concerts, comedy shows, sports, workshops and events with ETicketsGo.';

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage: node scripts/seo-check.mjs <base-url> --expect indexable|noindex [--event <slug>]',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a))?.replace(/\/+$/, '');
const expectIdx = args.indexOf('--expect');
const expectMode = expectIdx >= 0 ? args[expectIdx + 1] : undefined;
const eventIdx = args.indexOf('--event');
const eventSlug = eventIdx >= 0 ? args[eventIdx + 1] : undefined;
if (!base) usage('Missing base URL.');
if (expectMode !== 'indexable' && expectMode !== 'noindex')
  usage('--expect must be indexable or noindex.');
const indexable = expectMode === 'indexable';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function get(path) {
  const res = await fetch(`${base}${path}`, {
    redirect: 'manual',
    headers: { 'user-agent': 'ETicketsGo-seo-check/1.0 (read-only)' },
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}

/** The attribute of the first tag in `html` matching `tagPattern`. */
function attr(html, tagPattern, name) {
  const tag = html.match(tagPattern)?.[0];
  if (!tag) return null;
  const m = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m ? decode(m[1]) : null;
}

function headOf(html) {
  const end = html.search(/<\/head>/i);
  return end >= 0 ? html.slice(0, end) : '';
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
}

function robotsTagOk(value, label) {
  const v = (value ?? '').toLowerCase();
  if (indexable)
    check(`${label}: no X-Robots-Tag noindex`, !v.includes('noindex'), value ?? 'none');
  else check(`${label}: X-Robots-Tag noindex`, v.includes('noindex'), value ?? 'none');
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

async function main() {
  // Home page first: its canonical tells us the site's configured host.
  const home = await get('/');
  check('home page answers 200', home.status === 200, String(home.status));
  const head = headOf(home.body);
  check('home page has a <head>', head.length > 0);
  const title = decode(head.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  check('home title in <head>', title === HOME_TITLE, JSON.stringify(title));
  const description = attr(head, /<meta[^>]*name="description"[^>]*>/i, 'content');
  check(
    'home description in <head>',
    description === HOME_DESCRIPTION,
    JSON.stringify(description),
  );
  const canonical = attr(head, /<link[^>]*rel="canonical"[^>]*>/i, 'href');
  const siteHost = hostOf(canonical ?? '');
  check(
    'home canonical in <head> is the site root',
    Boolean(canonical) && new URL(canonical).pathname.replace(/\/+$/, '') === '',
    canonical ?? 'missing',
  );
  if (indexable) {
    check(
      'production canonical host is www.eticketsgo.com',
      siteHost === 'www.eticketsgo.com',
      siteHost ?? '',
    );
  }
  const robotsMeta = attr(head, /<meta[^>]*name="robots"[^>]*>/i, 'content') ?? '';
  if (indexable)
    check('home robots meta allows indexing', !/noindex/i.test(robotsMeta), robotsMeta || 'none');
  else check('home robots meta says noindex', /noindex/i.test(robotsMeta), robotsMeta || 'none');
  check('og:image in <head>', /<meta[^>]*property="og:image"/i.test(head));
  robotsTagOk(home.headers.get('x-robots-tag'), 'home');

  const blocks = jsonLdBlocks(home.body);
  check('home has JSON-LD', blocks.length > 0, `${blocks.length} block(s)`);
  for (const [i, raw] of blocks.entries()) {
    try {
      const data = JSON.parse(raw);
      const types = (Array.isArray(data) ? data : [data]).map((d) => d['@type']);
      check(`home JSON-LD #${i + 1} parses`, true, types.join(', '));
    } catch (e) {
      check(`home JSON-LD #${i + 1} parses`, false, String(e));
    }
  }
  check('home JSON-LD is in <head>', jsonLdBlocks(head).length > 0);

  // robots.txt
  const robots = await get('/robots.txt');
  check('robots.txt answers 200', robots.status === 200, String(robots.status));
  const disallowAll = /^Disallow:\s*\/\s*$/im.test(robots.body);
  const sitemapLine = robots.body.match(/^Sitemap:\s*(\S+)/im)?.[1];
  check('robots.txt has no Host line', !/^Host:/im.test(robots.body));
  if (indexable) {
    check('robots.txt does not disallow everything', !disallowAll);
    check('robots.txt lists the sitemap', Boolean(sitemapLine), sitemapLine ?? 'missing');
    if (sitemapLine)
      check('sitemap URL on the site host', hostOf(sitemapLine) === siteHost, sitemapLine);
  } else {
    check('robots.txt disallows everything', disallowAll);
    check('robots.txt advertises no sitemap', !sitemapLine, sitemapLine ?? 'none');
  }
  robotsTagOk(robots.headers.get('x-robots-tag'), 'robots.txt');

  // sitemap.xml
  const sitemap = await get('/sitemap.xml');
  check('sitemap.xml answers 200', sitemap.status === 200, String(sitemap.status));
  const xml = sitemap.body.trim();
  const wellFormed =
    xml.startsWith('<?xml') &&
    /<urlset[\s>]/.test(xml) &&
    /<\/urlset>\s*$/.test(xml) &&
    (xml.match(/<url>/g) ?? []).length === (xml.match(/<\/url>/g) ?? []).length;
  check('sitemap is well-formed XML', wellFormed);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]));
  if (indexable) {
    check('sitemap lists pages', locs.length > 0, `${locs.length} <loc>`);
    const off = locs.filter((l) => hostOf(l) !== siteHost);
    check('every <loc> is on the site host', off.length === 0, off.slice(0, 3).join(' '));
    const bad = locs.filter((l) =>
      /\/(privacy|terms|refunds|organizer-agreement|docs\/api|account|checkout|booking|login|register)(\/|$)/.test(
        new URL(l).pathname,
      ),
    );
    check('sitemap lists no noindex or private page', bad.length === 0, bad.slice(0, 3).join(' '));
  } else {
    check('sitemap is empty outside production', locs.length === 0, `${locs.length} <loc>`);
  }

  // An event page, when asked.
  if (eventSlug) {
    const ev = await get(`/events/${encodeURIComponent(eventSlug)}`);
    check('event page answers 200', ev.status === 200, String(ev.status));
    const evHead = headOf(ev.body);
    const evCanonical = attr(evHead, /<link[^>]*rel="canonical"[^>]*>/i, 'href') ?? '';
    check(
      'event canonical is the event itself',
      evCanonical.endsWith(`/events/${eventSlug}`),
      evCanonical || 'missing',
    );
    const events = jsonLdBlocks(ev.body).flatMap((raw) => {
      try {
        const d = JSON.parse(raw);
        return (Array.isArray(d) ? d : [d]).filter((x) => x['@type'] === 'Event');
      } catch {
        return [];
      }
    });
    check('event page has Event JSON-LD', events.length > 0, `${events.length}`);
    if (events[0]) {
      check('Event has name and startDate', Boolean(events[0].name && events[0].startDate));
    }
    const missing = await get('/events/seo-check-no-such-event-000');
    check('unknown event answers 404', missing.status === 404, String(missing.status));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed for ${base} (--expect ${expectMode})`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`FAIL  could not complete: ${e?.message ?? e}`);
  process.exit(1);
});
