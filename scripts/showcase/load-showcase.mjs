#!/usr/bin/env node
/**
 * Showcase loader: the fictional catalogue in catalogue.mjs, on a LOCAL stack, through the API.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Design work was being judged against seed rows called "Test Event 1712...", which made every
 * layout look worse than it is and hid the real problems: a long title, a poster crop, a price
 * in three currencies. This puts a believable catalogue on a designer's own machine so a
 * screenshot tells the truth. It goes through the same public API an organizer and an admin
 * use, so what the screenshots show is what the product does, not what a seed wrote around it.
 *
 * ── WHAT IT WILL AND WILL NOT DO ───────────────────────────────────────────────────
 * - Refuses any API that is not on this machine (local-guard.mjs), before any request.
 * - Registers one organizer account per catalogue organizer, registers its organization, and
 *   approves it as the local admin. If that path is refused, everything falls back to the
 *   seeded owner@eticketsgo.test organization, and the run says so.
 * - Creates the fictional venues (and a screen with a simple seat layout for each cinema),
 *   events with one session, ticket types and a cover image, and films with shows.
 * - Approves, as admin, only the events it created, so they reach the storefront.
 * - Idempotent: an item is found again by the `Showcase key:` line at the end of its
 *   description or synopsis, so a re-run fills in whatever an interrupted run left out.
 * - Never buys anything and never changes pricing policy, tax, payment or market settings.
 *   If the platform refuses a listing (a market not enabled, a price ceiling), that is
 *   reported, not worked around.
 *
 * Usage (from the repo root):
 *   node scripts/showcase/load-showcase.mjs --dry-run      # look up and print the plan only
 *   node scripts/showcase/load-showcase.mjs                # create what is missing
 *   node scripts/showcase/load-showcase.mjs --remove       # take the showcase items down
 *   node scripts/showcase/load-showcase.mjs --target qa    # the QA API, and nothing else remote
 *   options: --target <local|qa> (default local)
 *            --api <base>        (default http://localhost:4131/api; this machine only, or the
 *                                 exact QA API with --target qa)
 *            --admin-totp-file <f> (admin MFA: JSON of base32 secrets keyed by email, default
 *                                 C:/etg-wt/qa-secrets/qa-mfa.json; never printed)
 *            --accounts-file <f> (qa: where organizer passwords are kept, default
 *                                 C:/etg-wt/qa-secrets/showcase-qa-accounts.json)
 *            --images <dir>      (default C:/etg-wt/showcase/images)
 *            --credits <file>    (default: credits.json next to the images folder)
 *            --only <key,key>    only these catalogue keys
 *            --report <file>     write what was found/created/changed, with ids
 *            --single-org        skip organizer sign-up; use the seeded owner's organization
 *            --catalogue <file>  load another catalogue module with the same exports
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { DEFAULT_LOCAL_API, QA_API, targetVerdict } from './local-guard.mjs';
import { nextFreshCode } from './totp.mjs';
import { venueTimeToInstant } from '../qa-demo/venue-time.mjs';
import { pathToFileURL } from 'node:url';
import { SHOWCASE_MARKER, SHOWCASE_MARKER_QA, showcaseKeyLine } from './catalogue.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY_RUN = flag('--dry-run');
const REMOVE = flag('--remove');
const SINGLE_ORG = flag('--single-org');
const ONLY = option('--only')?.split(',');
const selected = (spec) => !ONLY || ONLY.includes(spec.key);

const TARGET = option('--target') ?? 'local';
const verdict = targetVerdict(
  TARGET,
  option('--api') ?? process.env.SHOWCASE_API ?? (TARGET === 'qa' ? QA_API : DEFAULT_LOCAL_API),
);
if (!verdict.allowed) {
  console.error(`REFUSED: ${verdict.reason}`);
  process.exit(2);
}
const API = verdict.apiBase;
const ON_QA = TARGET === 'qa';
const TOTP_FILE = option('--admin-totp-file') ?? 'C:/etg-wt/qa-secrets/qa-mfa.json';
const ACCOUNTS_FILE = option('--accounts-file') ?? 'C:/etg-wt/qa-secrets/showcase-qa-accounts.json';
/** The sentence every listing carries. Both say "fictional"; either marks the loader's own. */
const ACTIVE_MARKER = ON_QA ? SHOWCASE_MARKER_QA : SHOWCASE_MARKER;
const WHERE = ON_QA ? 'the QA environment' : 'a local machine';
/*
  Another catalogue with the same exports, for stress content a designer should also see (long
  titles, listings with no picture, one-event cities) without putting it in the curated
  showcase. It is marked and removed exactly like the showcase's own items.
*/
const CATALOGUE = option('--catalogue');
const { CITIES, EVENTS, FILMS, ORGANIZERS, VENUES } = CATALOGUE
  ? await import(pathToFileURL(CATALOGUE).href)
  : await import('./catalogue.mjs');
const IMAGE_DIR = option('--images') ?? 'C:/etg-wt/showcase/images';
const CREDITS_FILE = option('--credits') ?? join(dirname(IMAGE_DIR), 'credits.json');

/** The API refuses event images over 2 MB (EVENT_IMAGE_MAX_BYTES); bigger files are shrunk. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** What an organizer registers AS, per country. Approval needs it; it is never shown to buyers. */
const ENTITY_TYPE = { IN: 'Private limited company', US: 'LLC', CA: 'Corporation' };

const report = {
  api: API,
  mode: REMOVE ? 'remove' : DRY_RUN ? 'dry-run' : 'load',
  startedAt: new Date().toISOString(),
  organizerMode: SINGLE_ORG ? 'single-org (forced)' : 'one organization per organizer',
  organizers: [],
  venues: [],
  events: [],
  films: [],
  warnings: [],
};
const RUN_ID = Date.now().toString(36);
const warn = (msg) => {
  report.warnings.push(msg);
  console.warn(`  ! ${msg}`);
};

// ── HTTP ────────────────────────────────────────────────────────────────────────────

/** original token -> stepped-up token, and which account a token belongs to (for its secret). */
const tokenAlias = new Map();
const stepUpOwner = new Map();

/** The account's base32 TOTP secret from TOTP_FILE (a string, or { secret }); never printed. */
function totpSecretFor(email) {
  if (!email || !existsSync(TOTP_FILE)) return null;
  try {
    const v = JSON.parse(readFileSync(TOTP_FILE, 'utf8'))[email];
    return typeof v === 'string' ? v : (v?.secret ?? null);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One API call. Retries a 429 (the per-IP throttle) and a 502/503 (a restarting server) and
 * nothing else: a 4xx is an answer, not an accident.
 */
async function call(method, path, opts = {}, attempt = 1, steppedUp = false) {
  const { body, form, idempotencyKey } = opts;
  // A token that has been stepped up is replaced by the fresh one wherever it is still held.
  const token = tokenAlias.get(opts.token) ?? opts.token;
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, {
    method,
    headers,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt < 5) {
    await sleep(1500 * attempt);
    return call(method, path, opts, attempt + 1, steppedUp);
  }
  // A back-office action that wants a fresh second factor: confirm it once and retry once.
  if (
    res.status === 403 &&
    !steppedUp &&
    token &&
    JSON.stringify(data).includes('MFA_STEP_UP_REQUIRED')
  ) {
    const secret = totpSecretFor(stepUpOwner.get(opts.token));
    if (secret) {
      const r = await call('POST', '/auth/mfa/step-up', {
        token,
        body: { code: await nextFreshCode(secret) },
      });
      if (r?.accessToken) {
        tokenAlias.set(opts.token, r.accessToken);
        return call(method, path, opts, attempt, true);
      }
    }
  }
  if (!res.ok) {
    const raw = typeof data === 'object' && data ? (data.message ?? data.error) : data;
    const message = Array.isArray(raw) ? raw.join('; ') : String(raw).slice(0, 300);
    const err = new Error(`${method} ${path} -> ${res.status}: ${message}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Lists come back bare or wrapped, depending on the endpoint. */
const rows = (data) => (Array.isArray(data) ? data : (data?.data ?? data?.items ?? []));

/**
 * Tokens, or the reason there are none. When the account has a second factor and its secret is
 * in TOTP_FILE, the sign-in is completed with a computed code; otherwise it is a refusal.
 */
async function login(email, password) {
  let r = await call('POST', '/auth/login', { body: { email, password } });
  if (r?.mfaRequired) {
    const secret = totpSecretFor(email);
    if (!secret || !r.challengeToken) {
      const err = new Error(
        `${email} needs an authenticator code to sign in and no secret for it is in ${TOTP_FILE}.`,
      );
      err.mfa = true;
      throw err;
    }
    r = await call('POST', '/auth/mfa/verify', {
      body: { challengeToken: r.challengeToken, code: await nextFreshCode(secret) },
    });
  }
  if (!r?.accessToken) throw new Error(`No access token for ${email}.`);
  stepUpOwner.set(r.accessToken, email);
  return r.accessToken;
}

// ── Showcase identity ───────────────────────────────────────────────────────────────

/** About text, blank line, the marker, the key. The key line is always the last line. */
const describe = (about, key) => `${about}\n\n${ACTIVE_MARKER}\n${showcaseKeyLine(key)}`;

/** Ours only if the marker is present AND the key ends the text: never touch anyone else's. */
const isOurs = (text, key) =>
  typeof text === 'string' &&
  (text.includes(SHOWCASE_MARKER) || text.includes(SHOWCASE_MARKER_QA)) &&
  text.trimEnd().endsWith(showcaseKeyLine(key));

/**
 * An organizer password.
 *
 * LOCAL: deterministic (organizer key plus an optional salt), because those accounts exist only
 * on a developer's machine (the guard sees to that); the point is a password that passes the
 * platform's policy and that nobody has to keep, not a secret.
 *
 * QA: RANDOM, and kept in ACCOUNTS_FILE (outside the repository) so a re-run can sign in
 * again. It is written BEFORE the account is registered, so a crash between the two never
 * leaves an account whose password is lost, and it is never printed or put in the report.
 */
const qaAccounts = (() => {
  if (!ON_QA || !existsSync(ACCOUNTS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch (err) {
    console.error(`REFUSED: ${ACCOUNTS_FILE} exists but is not valid JSON (${err.message}).`);
    process.exit(2);
  }
})();
const organizerPassword = (orgKey) => {
  if (ON_QA) {
    const known = qaAccounts[orgKey]?.password;
    if (known) return known;
    // A dry run or removal must not mint (or write) credentials for accounts that may not exist.
    if (DRY_RUN || REMOVE) return null;
    const password = 'Qa-' + randomBytes(18).toString('base64url') + '-9a';
    qaAccounts[orgKey] = { email: organizerEmail(orgKey), password };
    mkdirSync(dirname(ACCOUNTS_FILE), { recursive: true });
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(qaAccounts, null, 2) + '\n', { mode: 0o600 });
    return password;
  }
  return (
    'Sc-' +
    createHash('sha256')
      .update(`eticketsgo-showcase-local:${orgKey}:${process.env.SHOWCASE_PASSWORD_SALT ?? ''}`)
      .digest('base64url')
      .slice(0, 22) +
    '-9a'
  );
};
const organizerEmail = (orgKey) => `showcase+${orgKey.toLowerCase()}@eticketsgo.test`;

// ── Images ──────────────────────────────────────────────────────────────────────────

/** credits.json may be a list, `{ images: [...] }` or keyed by image key; accept any. */
function loadCredits() {
  if (!existsSync(CREDITS_FILE)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(CREDITS_FILE, 'utf8'));
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw.images)
        ? raw.images
        : Object.entries(raw).map(([key, v]) => ({ key, ...v }));
    return new Map(list.filter((e) => e?.key).map((e) => [e.key, e]));
  } catch (err) {
    warn(`Could not read ${CREDITS_FILE}: ${err.message}. Focal points default to the centre.`);
    return new Map();
  }
}
const CREDITS = loadCredits();

/** A focal point as the API wants it, 0..1. Accepts percentages, which people also write. */
function focalFor(imageKey, fallback) {
  const c = CREDITS.get(imageKey);
  const f = c?.focal ?? c?.focalPoint ?? fallback;
  if (!f || typeof f.x !== 'number' || typeof f.y !== 'number') return null;
  const scale = f.x > 1 || f.y > 1 ? 100 : 1;
  const clamp = (v) => Math.min(1, Math.max(0, v / scale));
  return { x: clamp(f.x), y: clamp(f.y) };
}

let sharp;
/** sharp is already a dependency of the API; used only to shrink a photo over the API's cap. */
function loadSharp() {
  if (sharp !== undefined) return sharp;
  try {
    sharp = createRequire(import.meta.url)('sharp');
  } catch {
    sharp = null;
  }
  return sharp;
}

const imageCache = new Map();

/** The bytes of one catalogue image, or null (with a warning) when the file is not there. */
async function imageBytes(key) {
  if (imageCache.has(key)) return imageCache.get(key);
  const file = ['jpg', 'jpeg', 'webp', 'png']
    .map((ext) => join(IMAGE_DIR, `${key}.${ext}`))
    .find((p) => existsSync(p));
  if (!file) {
    warn(`Image "${key}" is not in ${IMAGE_DIR}; skipped. Re-run once it is there.`);
    imageCache.set(key, null);
    return null;
  }
  let buf = readFileSync(file);
  let type = file.endsWith('.png')
    ? 'image/png'
    : file.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg';
  if (buf.length > MAX_IMAGE_BYTES) {
    const s = loadSharp();
    if (!s) {
      warn(`Image "${key}" is over 2 MB and sharp is not available to shrink it; skipped.`);
      imageCache.set(key, null);
      return null;
    }
    // Shrink in steps until it fits; the API re-encodes its own variants anyway.
    for (const [edge, quality] of [
      [2400, 82],
      [2000, 78],
      [1600, 74],
    ]) {
      buf = await s(readFileSync(file))
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      type = 'image/jpeg';
      if (buf.length <= MAX_IMAGE_BYTES) break;
    }
  }
  const out = { buf, type, ext: type.split('/')[1].replace('jpeg', 'jpg') };
  imageCache.set(key, out);
  return out;
}

/** Upload one image to an event and set its focal point; answers with the new gallery entry. */
async function uploadImage(token, eventId, imageKey, focal) {
  const img = await imageBytes(imageKey);
  if (!img) return null;
  const form = new FormData();
  form.append('file', new Blob([img.buf], { type: img.type }), `${imageKey}.${img.ext}`);
  const before = await call('GET', `/events/${eventId}`, { token });
  const known = new Set((before.images ?? []).map((i) => i.id));
  const gallery = await call('POST', `/events/${eventId}/images`, {
    token,
    form,
    idempotencyKey: `showcase-image-${eventId}-${imageKey}`,
  });
  const added = (gallery.images ?? []).find((i) => !known.has(i.id)) ?? gallery.images?.at(-1);
  const point = focalFor(imageKey, focal);
  if (added && point) {
    await call('PUT', `/events/${eventId}/images/${added.id}/focal-point`, { token, body: point });
  }
  return added;
}

// ── Organizers ──────────────────────────────────────────────────────────────────────

/**
 * Sign the organizer's account in (registering it the first time), find or register its
 * organization, and approve the organization as admin if it is still waiting.
 */
async function ensureOrganizer(ctx, orgKey) {
  const spec = ORGANIZERS[orgKey];
  const email = organizerEmail(orgKey);
  const password = organizerPassword(orgKey);
  const entry = { key: orgKey, name: spec.name, email, actions: [] };
  report.organizers.push(entry);

  let token;
  try {
    // No stored QA password means this account was never made by this loader here.
    if (password === null) {
      const err = new Error('no stored password');
      err.status = 401;
      throw err;
    }
    token = await login(email, password);
  } catch (err) {
    if (err.mfa || (err.status && err.status !== 401)) throw err;
    if (DRY_RUN || REMOVE) {
      entry.actions.push(
        REMOVE
          ? 'no account, nothing to remove'
          : 'would register account and organization, then approve it',
      );
      return { key: orgKey, org: null, token: null, entry };
    }
    try {
      await call('POST', '/auth/register', {
        body: { email, password, fullName: `${spec.name} Team`, country: spec.country },
      });
    } catch (err) {
      if (ON_QA && err.status === 409) {
        // Registered earlier, but its password is not in ACCOUNTS_FILE: say so rather than
        // creating a second account or touching the first.
        throw new Error(
          `${email} already exists on QA and its password is not in ${ACCOUNTS_FILE}. ` +
            'Restore that file, or remove the account in the admin console.',
        );
      }
      throw err;
    }
    entry.actions.push('registered account');
    token = await login(email, password);
  }

  let org = rows(await call('GET', '/organizations', { token })).find((o) => o.name === spec.name);
  if (!org) {
    if (DRY_RUN || REMOVE) {
      entry.actions.push(
        REMOVE
          ? 'no organization, nothing to remove'
          : 'would register organization and approve it',
      );
      return { key: orgKey, org: null, token, entry };
    }
    org = await call('POST', '/organizations', {
      token,
      body: {
        name: spec.name,
        contactEmail: email,
        legalName: spec.name,
        legalEntityType: ENTITY_TYPE[spec.country],
        registeredCountry: spec.country,
      },
    });
    entry.actions.push('registered organization');
    // The organizer role is granted at registration; sign in again so the token carries it.
    token = await login(email, password);
  }
  entry.organizationId = org.id;
  if (org.status === 'PENDING' && !DRY_RUN && !REMOVE) {
    await call('POST', `/admin/organizers/${org.id}/review`, {
      token: ctx.admin,
      body: { decision: 'APPROVE', note: `Fictional showcase organizer on ${WHERE}.` },
    });
    entry.actions.push('approved as admin');
    org = { ...org, status: 'APPROVED' };
  }
  entry.status = org.status;
  console.log(`[organizer] ${spec.name}: ${entry.actions.join('; ') || 'ready'} (${org.status})`);
  return { key: orgKey, org, token, entry };
}

// ── Venues and cinemas ──────────────────────────────────────────────────────────────

/** Which organizer owns each venue: the one whose listings use it. */
function venueOwners() {
  const owners = new Map();
  for (const item of [...EVENTS, ...FILMS]) {
    if (!owners.has(item.venue)) owners.set(item.venue, item.organizer);
  }
  return owners;
}

async function ensureVenue(ctx, venueKey, orgCtx) {
  const spec = VENUES[venueKey];
  const where = CITIES[spec.at];
  const entry = { key: venueKey, name: spec.name, city: where.city, actions: [] };
  report.venues.push(entry);
  if (spec.kind === 'cinema' && where.state === 'Telangana') {
    // The catalogue avoids this already; the check stays so an edit cannot slip one in.
    throw new Error(`${spec.name} is a cinema in Telangana; the showcase must not use one.`);
  }
  if (!orgCtx.org) {
    entry.actions.push('would create (organizer not registered yet)');
    return { key: venueKey, venue: null };
  }
  const orgId = orgCtx.org.id;
  let venue = rows(
    await call('GET', `/venues?organizationId=${orgId}`, { token: orgCtx.token }),
  ).find((v) => v.name === spec.name);
  if (!venue) {
    if (DRY_RUN) {
      entry.actions.push('would create venue');
    } else {
      venue = await call('POST', '/venues', {
        token: orgCtx.token,
        body: {
          organizationId: orgId,
          name: spec.name,
          city: where.city,
          country: where.country,
          region: where.state,
          timezone: where.tz,
          address: spec.address,
        },
      });
      entry.actions.push('created venue');
    }
  }
  entry.id = venue?.id;
  const out = { key: venueKey, venue };
  if (spec.kind === 'cinema') Object.assign(out, await ensureCinema(ctx, venueKey, orgCtx, venue));
  console.log(`[venue] ${spec.name}: ${entry.actions.join('; ') || 'found'}`);
  return out;
}

/**
 * The seat sections for a cinema screen, cheapest at the front, priced as the film's ticket
 * classes. One film plays each showcase cinema, so the room's base prices ARE the film's.
 */
function seatSections(prices) {
  const rowsPer = prices.length >= 3 ? [6, 4, 2] : prices.length === 2 ? [7, 4] : [10];
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
  let next = 0;
  return prices.map((p, i) => {
    const count = rowsPer[i] ?? 2;
    const rowLabels = letters.slice(next, next + count);
    next += count;
    const recliner = /recliner/i.test(p.name);
    return {
      name: p.name,
      categoryName: p.name,
      basePriceMinor: p.priceMinor,
      rowLabels,
      seatsPerRow: recliner ? 10 : 16,
    };
  });
}

async function ensureCinema(ctx, venueKey, orgCtx, venue) {
  const spec = VENUES[venueKey];
  const where = CITIES[spec.at];
  const entry = report.venues.at(-1);
  const film = FILMS.find((f) => f.venue === venueKey);
  if (!venue) return { cinema: null, screen: null };
  const orgId = orgCtx.org.id;
  let cinema = rows(
    await call('GET', `/cinemas?organizationId=${orgId}`, { token: orgCtx.token }),
  ).find((c) => c.name === spec.name);
  if (!cinema) {
    if (DRY_RUN) {
      entry.actions.push('would create cinema, screen and seat layout');
      return { cinema: null, screen: null };
    }
    cinema = await call('POST', '/cinemas', {
      token: orgCtx.token,
      body: {
        organizationId: orgId,
        venueId: venue.id,
        name: spec.name,
        city: where.city,
        address: spec.address,
        country: where.country,
        region: where.state,
        district: where.city,
        timezone: where.tz,
      },
    });
    entry.actions.push('created cinema');
    /*
      The legal type (local body, format, cooling) decides a cinema's price limit, so an
      organizer cannot set it; the platform team does, as admin. Set the way the console does.
    */
    await call('PATCH', `/admin/cinemas/${cinema.id}/legal-type`, {
      token: ctx.admin,
      body: {
        cinemaFormat: 'MULTIPLEX',
        climateType: 'AC',
        localBodyType: where.country === 'IN' ? 'MUNICIPAL_CORPORATION' : null,
        reason: 'Showcase loader: fictional catalogue cinema.',
      },
    });
    entry.actions.push('set legal type as admin');
  }
  entry.cinemaId = cinema.id;
  let screen = rows(
    await call('GET', `/cinemas/${cinema.id}/screens`, { token: orgCtx.token }),
  ).find((s) => s.name === 'Screen 1');
  const sections = seatSections(film?.prices ?? [{ name: 'Standard', priceMinor: 20000 }]);
  if (!screen) {
    if (DRY_RUN) {
      entry.actions.push('would add Screen 1 and its seat layout');
      return { cinema, screen: null };
    }
    const capacity = sections.reduce((n, s) => n + s.rowLabels.length * s.seatsPerRow, 0);
    screen = await call('POST', `/cinemas/${cinema.id}/screens`, {
      token: orgCtx.token,
      body: { name: 'Screen 1', screenType: '2D', capacity },
    });
    entry.actions.push(`added Screen 1 (${capacity} seats)`);
  }
  entry.screenId = screen.id;
  let seatMap = null;
  try {
    seatMap = await call('GET', `/screens/${screen.id}/seatmap`, { token: orgCtx.token });
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (!seatMap && !DRY_RUN) {
    seatMap = await call('POST', `/screens/${screen.id}/seatmap`, {
      token: orgCtx.token,
      body: { name: 'Standard layout', sections },
    });
    entry.actions.push(`published seat layout (${sections.map((s) => s.categoryName).join(', ')})`);
  }
  // Read, never changed: if a regulated price ceiling applies here, the report says so and the
  // organizer console is where somebody decides what to do about it.
  try {
    const pc = await call('GET', `/cinemas/${cinema.id}/pricing-compliance`, {
      token: orgCtx.token,
    });
    entry.pricingCompliance = pc.status;
    if (!['NOT_REGULATED', 'COMPLIANT'].includes(pc.status)) {
      warn(`${spec.name}: pricing compliance is ${pc.status}. ${pc.summary ?? ''}`.trim());
    }
  } catch (err) {
    entry.pricingCompliance = `not available: ${err.message}`;
  }
  return { cinema, screen, seatMap };
}

// ── Events ──────────────────────────────────────────────────────────────────────────

async function loadEvent(ctx, spec) {
  const orgCtx = ctx.orgFor(spec.organizer);
  const venueSpec = VENUES[spec.venue];
  const where = CITIES[venueSpec.at];
  const entry = {
    key: spec.key,
    title: spec.title,
    organizer: orgCtx.org?.name ?? ORGANIZERS[spec.organizer].name,
    venue: venueSpec.name,
    actions: [],
  };
  report.events.push(entry);
  console.log(`\n[event] ${spec.title}  (${spec.key})`);

  const orgEvents = orgCtx.org ? await ctx.eventsOf(orgCtx) : [];
  let found = orgEvents.find((e) => isOurs(e.description, spec.key));

  if (REMOVE) return removeEvent(ctx, orgCtx, found, entry);

  if (!found) {
    const venue = ctx.venues.get(spec.venue)?.venue;
    if (DRY_RUN || !venue) {
      entry.actions.push('would create');
      console.log('  would create');
      return;
    }
    found = await call('POST', '/events', {
      token: orgCtx.token,
      // Per run, not per key: it guards a retry within this run, and a key reused after
      // --remove deleted the event would be answered with "since been deleted".
      idempotencyKey: `showcase-event-${spec.key}-${RUN_ID}`,
      body: {
        organizationId: orgCtx.org.id,
        venueId: venue.id,
        title: spec.title,
        category: spec.category,
        description: describe(spec.about, spec.key),
        isFree: false,
        ...(spec.ageLimit ? { ageLimit: spec.ageLimit } : {}),
        ...(spec.artists ? { artists: spec.artists } : {}),
      },
    });
    entry.actions.push('created event');
  }
  entry.id = found.id;
  let detail = await call('GET', `/events/${found.id}`, { token: orgCtx.token });
  if (DRY_RUN) {
    entry.actions.push(
      `status ${detail.status}, ${detail.sessions.length} session(s), ${detail.images.length} image(s)`,
    );
    console.log(`  ${entry.actions.at(-1)}`);
    return;
  }

  // One session and its ticket types, only if the event has none: never a second session.
  if (detail.sessions.length === 0) {
    const startsAt = venueTimeToInstant(spec.date, spec.time, where.tz);
    const endsAt = new Date(startsAt.getTime() + spec.hours * 3600_000);
    await call('POST', `/events/${found.id}/sessions`, {
      token: orgCtx.token,
      body: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
    });
    entry.actions.push(`added session ${spec.date} ${spec.time} ${where.tz}`);
    detail = await call('GET', `/events/${found.id}`, { token: orgCtx.token });
  }
  const session = detail.sessions[0];
  if ((session.ticketTypes ?? []).length === 0) {
    for (const t of spec.tickets) {
      await call('POST', '/events/ticket-types', {
        token: orgCtx.token,
        body: {
          eventSessionId: session.id,
          name: t.name,
          priceMinor: t.priceMinor,
          quantityTotal: t.quantityTotal,
          maxPerOrder: t.maxPerOrder ?? 10,
        },
      });
    }
    entry.actions.push(`added ${spec.tickets.length} ticket type(s) in ${where.currency}`);
  }

  if (detail.images.length === 0 && spec.image) {
    const added = await uploadImage(orgCtx.token, found.id, spec.image, spec.focal);
    if (added) entry.actions.push(`uploaded cover ${spec.image}`);
  }

  // Review: submit a draft, then approve it as admin. Nothing else is ever approved here.
  detail = await call('GET', `/events/${found.id}`, { token: orgCtx.token });
  if (detail.status === 'DRAFT') {
    const sell = await call('GET', `/events/${found.id}/sellability`, { token: orgCtx.token });
    if (sell.sellable === false) {
      warn(
        `${spec.key} is not sellable, left as a draft: ${(sell.blockers ?? []).map((b) => b.message ?? b).join(' / ')}`,
      );
    } else {
      await call('POST', `/events/${found.id}/submit`, { token: orgCtx.token });
      entry.actions.push('submitted for review');
      detail = await call('GET', `/events/${found.id}`, { token: orgCtx.token });
    }
  }
  if (detail.status === 'UNDER_REVIEW' && isOurs(detail.description, spec.key)) {
    await call('POST', `/admin/events/${found.id}/review`, {
      token: ctx.admin,
      body: { decision: 'APPROVE', note: `Fictional showcase listing on ${WHERE}.` },
    });
    entry.actions.push('approved as admin');
  }
  detail = await call('GET', `/events/${found.id}`, { token: orgCtx.token });
  entry.status = detail.status;
  entry.slug = detail.slug;
  entry.images = detail.images.map((i) => i.id);
  console.log(`  ${entry.actions.join('; ') || 'nothing to do'} -> ${entry.status}`);
}

/**
 * Delete the event outright when nothing was ever sold for it (images, sessions and tickets
 * go with it); otherwise archive it, which takes it off the storefront and keeps the records.
 */
async function removeEvent(ctx, orgCtx, found, entry) {
  if (!found) return void entry.actions.push('not found');
  entry.id = found.id;
  if (DRY_RUN) {
    entry.actions.push(`would delete (or archive) ${found.id}`);
  } else {
    try {
      await call('DELETE', `/events/${found.id}`, { token: orgCtx.token });
      entry.actions.push('deleted');
    } catch (err) {
      if (!['ARCHIVED', 'CANCELLED', 'COMPLETED'].includes(found.status)) {
        await call('POST', `/admin/events/${found.id}/status`, {
          token: ctx.admin,
          body: { status: 'ARCHIVED' },
        });
        entry.actions.push(`archived (delete refused: ${err.message})`);
      } else {
        entry.actions.push(`left as ${found.status} (delete refused: ${err.message})`);
      }
    }
  }
  console.log(`  ${entry.actions.at(-1)}`);
}

// ── Films ───────────────────────────────────────────────────────────────────────────

async function loadFilm(ctx, spec) {
  const orgCtx = ctx.orgFor(spec.organizer);
  const venueSpec = VENUES[spec.venue];
  const where = CITIES[venueSpec.at];
  const entry = {
    key: spec.key,
    title: spec.title,
    cinema: venueSpec.name,
    actions: [],
    shows: [],
  };
  report.films.push(entry);
  console.log(`\n[film] ${spec.title}  (${spec.key})`);

  let movie = null;
  if (orgCtx.org) {
    const list = rows(
      await call('GET', `/movies?organizationId=${orgCtx.org.id}`, { token: orgCtx.token }),
    );
    for (const m of list.filter((m) => m.title === spec.title)) {
      const full = await call('GET', `/movies/${m.id}`, { token: orgCtx.token });
      if (isOurs(full.synopsis, spec.key)) movie = full;
      else warn(`Film "${spec.title}" exists but is not a showcase item (${m.id}); left alone.`);
    }
  }

  if (REMOVE) return removeFilm(ctx, orgCtx, movie, entry);

  const place = ctx.venues.get(spec.venue);
  if (!movie) {
    if (DRY_RUN || !place?.screen) {
      entry.actions.push('would create');
      console.log('  would create');
      return;
    }
    movie = await call('POST', '/movies', {
      token: orgCtx.token,
      body: {
        organizationId: orgCtx.org.id,
        title: spec.title,
        synopsis: describe(spec.synopsis, spec.key),
        runtimeMinutes: spec.minutes,
        certificate: spec.certificate,
        language: spec.language,
        genres: spec.genres,
      },
    });
    entry.actions.push('created film');
  }
  entry.id = movie.id;
  if (DRY_RUN) {
    entry.actions.push(`status ${movie.status}, poster ${movie.posterUrl ? 'set' : 'missing'}`);
    console.log(`  ${entry.actions.at(-1)}`);
    return;
  }
  if (movie.status !== 'PUBLISHED') {
    await call('POST', `/movies/${movie.id}/status`, {
      token: orgCtx.token,
      body: { status: 'PUBLISHED' },
    });
    entry.actions.push('published film');
  }

  // The layout's categories, so each show is priced exactly as the catalogue says even if
  // the room was laid out by an earlier run with different prices.
  const categories =
    place.seatMap?.categories ??
    place.seatMap?.seatCategories ??
    place.seatMap?.seatMap?.categories;
  const pricing = (categories ?? [])
    .map((c) => {
      const p = spec.prices.find((x) => x.name === c.name);
      return p ? { seatCategoryId: c.id, priceMinor: p.priceMinor } : null;
    })
    .filter(Boolean);

  // Each planned slot once. A slot already taken on the screen is reported, not moved.
  let shows = await call('GET', `/movies/${movie.id}/shows`, { token: orgCtx.token });
  const taken = new Set(
    shows
      .filter((s) => s.screenId === place.screen.id && s.status !== 'CANCELLED')
      .map((s) => new Date(s.startsAt).getTime()),
  );
  let scheduled = 0;
  for (const date of spec.dates) {
    for (const time of spec.times) {
      const startsAt = venueTimeToInstant(date, time, where.tz);
      if (taken.has(startsAt.getTime())) continue;
      const endsAt = new Date(startsAt.getTime() + spec.minutes * 60000);
      try {
        await call('POST', `/movies/${movie.id}/shows`, {
          token: orgCtx.token,
          body: {
            screenId: place.screen.id,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            ...(pricing.length ? { pricing } : {}),
          },
        });
        scheduled++;
      } catch (err) {
        warn(`${spec.key}: show ${date} ${time} not scheduled: ${err.message}`);
      }
    }
  }
  if (scheduled) entry.actions.push(`scheduled ${scheduled} show(s)`);
  shows = await call('GET', `/movies/${movie.id}/shows`, { token: orgCtx.token });
  const mine = shows.filter((s) => s.screenId === place.screen.id && s.status !== 'CANCELLED');
  entry.shows = mine.map((s) => ({ sessionId: s.sessionId, startsAt: s.startsAt }));
  const eventId = mine[0]?.eventId;
  entry.listingEventId = eventId;

  // Images go on the film's listing at this cinema and are served by the API. The backdrop
  // first, because the first image is the listing's landscape cover; the poster second, and
  // the film's posterUrl points at it.
  if (eventId) {
    let listing = await call('GET', `/events/${eventId}`, { token: orgCtx.token });
    entry.listingSlug = listing.slug;
    const want = [spec.backdrop, spec.poster].slice(listing.images.length);
    for (const key of want) {
      const added = await uploadImage(orgCtx.token, eventId, key);
      if (added) entry.actions.push(`uploaded ${key}`);
      else break; // keep the order: a missing backdrop must not let the poster become cover
    }
    listing = await call('GET', `/events/${eventId}`, { token: orgCtx.token });
    const poster = listing.images[1];
    const posterUrl = poster ? `${API}/public/events/${eventId}/images/${poster.id}/full` : null;
    if (posterUrl && movie.posterUrl !== posterUrl) {
      await call('PATCH', `/movies/${movie.id}`, { token: orgCtx.token, body: { posterUrl } });
      entry.actions.push('set posterUrl');
    }
    entry.posterImageId = poster?.id;
  }
  movie = await call('GET', `/movies/${movie.id}`, { token: orgCtx.token });
  entry.slug = movie.slug;
  console.log(`  ${entry.actions.join('; ') || 'nothing to do'}`);
}

/** Cancel future shows (frees the screen), archive each listing, then archive the film. */
async function removeFilm(ctx, orgCtx, movie, entry) {
  if (!movie) return void entry.actions.push('not found');
  entry.id = movie.id;
  const shows = await call('GET', `/movies/${movie.id}/shows`, { token: orgCtx.token });
  for (const s of shows) {
    if (s.status === 'CANCELLED' || new Date(s.startsAt) <= new Date()) continue;
    if (!DRY_RUN) {
      await call('POST', `/shows/${s.sessionId}/cancel`, {
        token: orgCtx.token,
        body: { reason: 'Showcase listing removed by scripts/showcase.' },
      });
    }
    entry.actions.push(`${DRY_RUN ? 'would cancel' : 'cancelled'} show ${s.sessionId}`);
  }
  // The listing is deleted when nothing was sold, so a later load starts it afresh; an
  // archived listing would be found again by the scheduler and hide every new show.
  for (const eventId of new Set(shows.map((s) => s.eventId))) {
    if (DRY_RUN) {
      entry.actions.push(`would delete (or archive) listing ${eventId}`);
      continue;
    }
    try {
      await call('DELETE', `/events/${eventId}`, { token: orgCtx.token });
      entry.actions.push(`deleted listing ${eventId}`);
    } catch (err) {
      await call('POST', `/admin/events/${eventId}/status`, {
        token: ctx.admin,
        body: { status: 'ARCHIVED' },
      });
      entry.actions.push(`archived listing ${eventId} (delete refused: ${err.message})`);
    }
  }
  if (movie.status !== 'ARCHIVED') {
    if (!DRY_RUN) {
      await call('POST', `/movies/${movie.id}/status`, {
        token: orgCtx.token,
        body: { status: 'ARCHIVED' },
      });
    }
    entry.actions.push(DRY_RUN ? 'would archive film' : 'archived film');
  }
  console.log(`  ${entry.actions.join('; ') || 'nothing to do'}`);
}

// ── Main ────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Showcase ${report.mode} against ${API}`);
  console.log(`Images from ${IMAGE_DIR}${existsSync(IMAGE_DIR) ? '' : ' (folder not found)'}`);
  const admin = await login(
    process.env.SHOWCASE_ADMIN_EMAIL ?? 'admin@eticketsgo.test',
    process.env.SHOWCASE_ADMIN_PASSWORD ?? 'Password123!',
  );

  const items = [...EVENTS, ...FILMS].filter(selected);
  const orgKeys = [...new Set(items.map((i) => i.organizer))];

  // One organization per catalogue organizer; the seeded owner's organization if that path
  // is refused, so a designer still gets a catalogue (with one organizer name on every page).
  const orgs = new Map();
  let fallback = null;
  const useFallback = async (why) => {
    // On QA the seeded owner's organization holds the certification fixtures; putting the
    // demo catalogue there would defeat the point. Stop instead.
    if (ON_QA) throw new Error(`${why ?? 'single-org was requested'} (no fallback on QA)`);
    if (!fallback) {
      if (why) warn(`Falling back to the seeded owner organization: ${why}`);
      report.organizerMode = SINGLE_ORG
        ? 'single-org (forced)'
        : 'single-org (fallback, see warnings)';
      const token = await login(
        process.env.SHOWCASE_OWNER_EMAIL ?? 'owner@eticketsgo.test',
        process.env.SHOWCASE_OWNER_PASSWORD ?? 'Password123!',
      );
      const org = rows(await call('GET', '/organizations', { token })).find(
        (o) => o.status === 'APPROVED',
      );
      if (!org) throw new Error('The seeded owner has no approved organization to fall back to.');
      fallback = { key: 'owner', org, token };
    }
    return fallback;
  };
  for (const key of orgKeys) {
    if (SINGLE_ORG) {
      orgs.set(key, await useFallback());
      continue;
    }
    try {
      orgs.set(key, await ensureOrganizer({ admin }, key));
    } catch (err) {
      orgs.set(key, await useFallback(`${ORGANIZERS[key].name}: ${err.message}`));
    }
  }

  const eventCache = new Map();
  const ctx = {
    admin,
    orgFor: (key) => orgs.get(key),
    eventsOf: async (orgCtx) => {
      if (!eventCache.has(orgCtx.org.id)) {
        const list = rows(
          await call('GET', `/events?organizationId=${orgCtx.org.id}`, { token: orgCtx.token }),
        );
        eventCache.set(orgCtx.org.id, list);
      }
      return eventCache.get(orgCtx.org.id);
    },
    venues: new Map(),
  };

  if (!REMOVE) {
    const owners = venueOwners();
    const venueKeys = [...new Set(items.map((i) => i.venue))];
    for (const key of venueKeys) {
      try {
        ctx.venues.set(key, await ensureVenue(ctx, key, orgs.get(owners.get(key))));
      } catch (err) {
        warn(`venue ${key}: ${err.message}`);
      }
    }
  }

  for (const spec of EVENTS.filter(selected)) {
    try {
      await loadEvent(ctx, spec);
    } catch (err) {
      warn(`${spec.key}: ${err.message}`);
    }
  }
  for (const spec of FILMS.filter(selected)) {
    try {
      await loadFilm(ctx, spec);
    } catch (err) {
      warn(`${spec.key}: ${err.message}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  // What the API's DEMO_ORGANIZATION_IDS must hold for these listings to be labelled DEMO.
  // Organization ids are not secrets. Passwords are never printed.
  const demoOrgIds = [
    ...new Set(
      report.organizers.map((o) => o.organizationId).filter((id) => id && fallback?.org?.id !== id),
    ),
  ];
  const out = option('--report');
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `\nDone (${report.organizerMode}): ${report.organizers.length} organizers, ` +
      `${report.venues.length} venues, ${report.events.length} events, ` +
      `${report.films.length} films, ${report.warnings.length} warning(s).`,
  );
  if (demoOrgIds.length) {
    console.log(`
DEMO_ORGANIZATION_IDS=${demoOrgIds.join(',')}`);
    console.log('(set this variable on the API service to label these listings DEMO)');
  }
  if (report.warnings.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
