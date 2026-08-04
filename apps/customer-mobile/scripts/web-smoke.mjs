/**
 * Runtime smoke test for the exported web bundle.
 *
 * WHAT THIS IS. It serves `expo export --platform web` output and drives it with a real
 * Chromium at a phone viewport, against the live QA API. That exercises the actual
 * application code — providers, router, React Query, the Zod parsers, the API client —
 * and catches the class of failure that no amount of typechecking will: a screen that
 * throws on mount, a provider in the wrong order, a response the parser rejects.
 *
 * WHAT THIS IS NOT. It is not device validation. react-native-web substitutes DOM
 * elements for native views, so nothing here proves anything about native modules
 * (SecureStore, Brightness, Haptics, Notifications), gesture handling, the real
 * navigator, or how any of it looks on an actual phone. Those need an emulator or a
 * device, and the results of this script must never be reported as if they did.
 *
 * Usage: node scripts/web-smoke.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const DIST = resolve(process.cwd(), 'dist');
const PORT = Number(process.argv[2] ?? 8099);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

/**
 * The QA API this harness proxies to.
 *
 * A browser sends an Origin header and is subject to CORS; a native app sends neither.
 * Pointing the page straight at the QA host therefore fails every request from
 * http://localhost — which says nothing about the app, only about the harness. Adding
 * localhost to QA's CORS_ORIGINS to make a local test pass would be weakening a
 * deployed environment's security for a test's convenience, so instead the requests are
 * forwarded server-side here, where CORS does not apply. QA is unchanged.
 */
const API_TARGET = process.env.SMOKE_API_TARGET ?? 'https://api-qa-f580.up.railway.app/api';

/** Static server with SPA fallback, so client-side routes resolve like they would hosted. */
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      const target = `${API_TARGET}${url.pathname.replace(/^\/api/, '')}${url.search}`;
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] ?? 'application/json',
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: 'half',
      }).catch((e) => {
        res.writeHead(502).end(JSON.stringify({ message: String(e) }));
        return null;
      });
      if (!upstream) return;
      const payload = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      res.end(payload);
      return;
    }
    // normalize + prefix check: this serves from disk, and a request for
    // /../../.env must not escape the export directory.
    let filePath = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) {
      filePath = join(filePath, 'index.html');
      info = await stat(filePath).catch(() => null);
    }
    if (!info) {
      // Expo exports one HTML file per route; fall back to the route's .html, then root.
      const asHtml = `${filePath}.html`;
      info = await stat(asHtml).catch(() => null);
      filePath = info ? asHtml : join(DIST, 'index.html');
    }

    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(500).end('error');
  }
});

const results = [];
function record(step, ok, detail = '') {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Screenshots go to a gitignored folder. They are evidence for a report, not fixtures:
 * nothing asserts against them, and they are not committed — a binary that changes on
 * every font-rendering difference is noise in a diff.
 */
const SHOTS = resolve(process.cwd(), '.smoke-screenshots');
let shotIndex = 0;
async function shot(page, name) {
  shotIndex += 1;
  await page
    .screenshot({ path: join(SHOTS, `${String(shotIndex).padStart(2, '0')}-${name}.png`) })
    .catch(() => undefined);
}

await mkdir(SHOTS, { recursive: true });
await new Promise((r) => server.listen(PORT, r));
console.log(`serving dist on http://localhost:${PORT}`);

/**
 * Wake the API before measuring anything.
 *
 * QA runs with Railway's app-sleeping enabled to keep costs down, so the first request
 * after an idle period pays a cold start of several seconds. Without this the run is
 * intermittently scored against a container that is still booting — an earlier run came
 * back 16/18 for exactly that reason and 18/18 immediately after, which is a flaky
 * harness reporting a flaky app.
 */
process.stdout.write('waking QA API… ');
const wokeAt = Date.now();
for (let attempt = 0; attempt < 6; attempt += 1) {
  const ok = await fetch(`${API_TARGET}/health`, { signal: AbortSignal.timeout(30_000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (ok) break;
}
console.log(`${Math.round((Date.now() - wokeAt) / 1000)}s\n`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, // iPhone 14 logical size
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

/** Anything the app logs as an error is a finding, not noise. */
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const base = `http://localhost:${PORT}`;

try {
  // 1 — cold launch
  //
  // The entry route is a client-side <Redirect> to /(tabs), so `networkidle` resolves
  // while the page is still the empty pre-redirect shell — asserting immediately reads
  // 0 characters and reports a working app as broken. Wait for actual rendered content
  // instead. (Every later goto lands directly on a route and does not need this.)
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60_000 });
  const rendered = await page
    .waitForFunction(() => (document.body?.innerText ?? '').trim().length > 0, {
      timeout: 30_000,
    })
    .then(() => true)
    .catch(() => false);
  const bodyText = rendered ? await page.locator('body').innerText() : '';
  record('cold launch renders', rendered, `${bodyText.length} chars`);
  await shot(page, 'home');

  // 2 — discovery loaded from the live QA API
  const sawDiscovery = await page
    .getByText(/Discover|Trending|Now showing/i)
    .first()
    .isVisible()
    .catch(() => false);
  record('home shows discovery content from QA', sawDiscovery);

  // 3 — a real event title proves the API round-trip and the Zod parse both succeeded
  const sawRealEvent = await page
    .getByText(/Sunburn Arena|Standup Night|DevConf/i)
    .first()
    .isVisible()
    .catch(() => false);
  record('live event data rendered (API + schema parse)', sawRealEvent);

  // 4 — tab bar present
  for (const tab of ['Home', 'Search', 'Tickets', 'Profile']) {
    const visible = await page
      .getByText(tab, { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    record(`tab "${tab}" present`, visible);
  }

  // 5 — search route
  await page.goto(`${base}/search`, { waitUntil: 'networkidle', timeout: 60_000 });
  record('search screen renders', (await page.locator('body').innerText()).includes('Search'));
  await shot(page, 'search');

  // 6 — tickets tab signed out shows the auth prompt, not a crash and not a wall
  await page.goto(`${base}/tickets`, { waitUntil: 'networkidle', timeout: 60_000 });
  const ticketsText = await page.locator('body').innerText();
  record('tickets prompts sign-in when signed out', /Sign in|tickets live here/i.test(ticketsText));
  await shot(page, 'tickets-signed-out');

  // 7 — profile readable signed out
  await page.goto(`${base}/profile`, { waitUntil: 'networkidle', timeout: 60_000 });
  const profileText = await page.locator('body').innerText();
  record('profile readable signed out', /guest|Profile/i.test(profileText));
  await shot(page, 'profile');

  // 8 — event detail against a real slug
  await page.goto(`${base}/event/standup-night-with-zomato-comedy`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  const eventText = await page.locator('body').innerText();
  record('event detail loads a real event', /Standup Night/i.test(eventText));
  record('ticket types rendered', /General|Gold|VIP/i.test(eventText));
  await shot(page, 'event-detail');

  // 9 — the reserved-seat screen for the seeded movie session
  await page.goto(`${base}/event/skyfront-protocol-show-598484`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  const movieEventText = await page.locator('body').innerText();
  record('movie event loads', /Skyfront/i.test(movieEventText));
  record(
    'reserved seating routes to the seat map',
    /Choose seats|reserved seating/i.test(movieEventText),
  );

  await page.goto(`${base}/session/cmsdp3od100758jznrl6atlru/seats`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  const seatsText = await page.locator('body').innerText();
  record('seat map screen renders', /seat|SCREEN|Available/i.test(seatsText));
  record('seat legend rendered', /Available/i.test(seatsText) && /Sold/i.test(seatsText));
  await shot(page, 'seat-map');

  // 10 — auth screens
  await page.goto(`${base}/register`, { waitUntil: 'networkidle', timeout: 60_000 });
  record('register screen renders', /Create account/i.test(await page.locator('body').innerText()));

  // 11 — unknown route falls back rather than crashing
  await page.goto(`${base}/definitely-not-a-route`, { waitUntil: 'networkidle', timeout: 60_000 });
  const notFound = await page.locator('body').innerText();
  record('unknown route handled', notFound.length > 0);
} catch (err) {
  record('run completed without throwing', false, String(err).slice(0, 200));
} finally {
  await browser.close();
  server.close();
}

console.log('\n--- console errors ---');
// react-native-web logs known, harmless deprecations; everything else is worth seeing.
const notable = consoleErrors.filter(
  (e) => !/deprecated|Download the React DevTools|useNativeDriver|pointerEvents/i.test(e),
);
console.log(notable.length ? notable.slice(0, 12).join('\n') : '(none)');
console.log('\n--- uncaught page errors ---');
console.log(pageErrors.length ? pageErrors.slice(0, 12).join('\n') : '(none)');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 && pageErrors.length === 0 ? 0 : 1);
