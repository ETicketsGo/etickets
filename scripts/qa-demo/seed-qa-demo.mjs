#!/usr/bin/env node
/**
 * QA demo dataset: realistic events, films and licensed photography on the QA environment.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Every event on QA was made by a test, so every card is the branded placeholder and every
 * title ends in a timestamp. Image cropping, focal points, portrait posters and very wide
 * banners could not be judged against anything that looks like a real catalogue. The owner
 * asked for a QA-only demo set; this is it, made through the same public API an organizer
 * and an admin use, so it exercises the product rather than going around it.
 *
 * ── WHAT IT WILL AND WILL NOT DO ───────────────────────────────────────────────────
 * - Refuses to run against anything but the QA API (qa-guard.mjs), before any request.
 * - Only ADDS: new events, their sessions, ticket types and images; new films, their shows
 *   on an existing Andhra Pradesh screen, and their posters. It never edits, replaces or
 *   deletes an item it did not create - an item counts as ours only if its description
 *   carries both the demo marker and its demo key.
 * - Approves, as admin, only the events it created, so they reach the storefront.
 * - Idempotent: each item is found again by its demo key, so a re-run fills in whatever an
 *   interrupted run left out and duplicates nothing.
 * - Never buys anything and never changes pricing policy, payment, Telangana or USD rules.
 *
 * Usage (from the repo root):
 *   node scripts/qa-demo/seed-qa-demo.mjs --dry-run     # look up and print the plan only
 *   node scripts/qa-demo/seed-qa-demo.mjs               # create what is missing
 *   node scripts/qa-demo/seed-qa-demo.mjs --cleanup     # archive demo events, cancel demo
 *                                                       # shows, archive demo films
 *   options: --api <base>  (default https://api-qa.eticketsgo.com/api; QA hosts only)
 *            --report <file.json>  write what was found/created/changed
 *            --only <key,key>      only these demo keys (see demo-dataset.mjs)
 *   env:     QA_DEMO_OWNER_EMAIL / QA_DEMO_OWNER_PASSWORD, QA_DEMO_ADMIN_EMAIL /
 *            QA_DEMO_ADMIN_PASSWORD (default: the seeded QA test accounts)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_QA_API, qaTargetVerdict } from './qa-guard.mjs';
import { venueTimeToInstant } from './venue-time.mjs';
import {
  CINEMA,
  DEMO_MARKER,
  EVENTS,
  MOVIES,
  ORGANIZATION_NAME,
  VENUES,
  demoKeyLine,
} from './demo-dataset.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY_RUN = flag('--dry-run');
const CLEANUP = flag('--cleanup');
// Limit a run to some demo keys (comma-separated), e.g. to try one item before the rest.
const ONLY = option('--only')?.split(',');
const selected = (spec) => !ONLY || ONLY.includes(spec.key);

const verdict = qaTargetVerdict(option('--api') ?? process.env.QA_DEMO_API ?? DEFAULT_QA_API);
if (!verdict.allowed) {
  console.error(`REFUSED: ${verdict.reason}`);
  process.exit(2);
}
const API = verdict.apiBase;

const MANIFEST = JSON.parse(readFileSync(new URL('./IMAGE-SOURCES.json', import.meta.url), 'utf8'));
const IMAGES = new Map(MANIFEST.images.map((i) => [i.key, i]));

const report = {
  api: API,
  mode: CLEANUP ? 'cleanup' : DRY_RUN ? 'dry-run' : 'seed',
  startedAt: new Date().toISOString(),
  events: [],
  movies: [],
  warnings: [],
};
const warn = (msg) => {
  report.warnings.push(msg);
  console.warn(`  ! ${msg}`);
};

// ── HTTP ────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One API call. Retries what is worth retrying (a 429 from the per-IP throttle, a 502/503
 * while Railway swaps a deployment) and nothing else: a 4xx is an answer, not an accident.
 */
async function call(method, path, { token, body, form, idempotencyKey } = {}, attempt = 1) {
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
    return call(method, path, { token, body, form, idempotencyKey }, attempt + 1);
  }
  if (!res.ok) {
    const message = typeof data === 'object' && data ? data.message : String(data).slice(0, 200);
    const err = new Error(`${method} ${path} -> ${res.status}: ${message}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function login(email, password) {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  if (!r?.accessToken) throw new Error(`No access token for ${email}.`);
  return r.accessToken;
}

// ── Images ──────────────────────────────────────────────────────────────────────────

const imageCache = new Map();

/**
 * The bytes of one manifest image, checked against the recorded hash.
 *
 * A mismatch is refused rather than uploaded: the manifest's provenance (author, licence)
 * describes THOSE bytes, and a source that now serves something else is no longer the
 * picture that was licensed.
 */
async function imageBytes(key) {
  if (imageCache.has(key)) return imageCache.get(key);
  const spec = IMAGES.get(key);
  if (!spec) throw new Error(`Image "${key}" is not in IMAGE-SOURCES.json.`);
  const res = await fetch(spec.downloadUrl, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; eticketsgo-qa-demo/1.0)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Download of ${key} failed: HTTP ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (spec.sha256 && sha !== spec.sha256) {
    throw new Error(`Download of ${key} no longer matches its recorded sha256; refusing it.`);
  }
  const type = buf.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : 'image/jpeg';
  const out = { buf, type, ext: type === 'image/webp' ? 'webp' : 'jpg', spec };
  imageCache.set(key, out);
  return out;
}

/** Upload one image to an event and centre its crops; answers with the new gallery entry. */
async function uploadImage(token, eventId, imageKey, idempotencyKey) {
  const { buf, type, ext, spec } = await imageBytes(imageKey);
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), `${imageKey}.${ext}`);
  const before = await call('GET', `/events/${eventId}`, { token });
  const known = new Set((before.images ?? []).map((i) => i.id));
  const gallery = await call('POST', `/events/${eventId}/images`, {
    token,
    form,
    idempotencyKey,
  });
  const added = (gallery.images ?? []).find((i) => !known.has(i.id)) ?? gallery.images?.at(-1);
  if (added && spec.focalPoint) {
    await call('PUT', `/events/${eventId}/images/${added.id}/focal-point`, {
      token,
      body: spec.focalPoint,
    });
  }
  return added;
}

const credit = (keys) =>
  keys
    .map((k) => IMAGES.get(k))
    .filter(Boolean)
    .map((i) => `${i.author} via ${i.source.replace(/ \(.*\)$/, '')}`)
    .join('; ');

function description(item, imageKeys) {
  const lines = [DEMO_MARKER, '', item.about, ''];
  if (imageKeys.length) {
    lines.push(`Sample photos (CC0, not the organizer's own): ${credit(imageKeys)}.`);
  }
  lines.push(demoKeyLine(item.key));
  return lines.join('\n');
}

/** Ours only if BOTH the marker and the key are present: never touch anyone else's row. */
const isOurs = (text, key) =>
  typeof text === 'string' && text.startsWith(DEMO_MARKER) && text.includes(demoKeyLine(key));

// ── Events ──────────────────────────────────────────────────────────────────────────

async function seedEvent(ctx, spec) {
  const venue = ctx.venues.get(spec.venue);
  const tz = VENUES[spec.venue].tz;
  const entry = { key: spec.key, title: spec.title, venue: venue.name, actions: [] };
  report.events.push(entry);
  console.log(`\n[event] ${spec.title}  (${spec.key})`);

  let found = ctx.orgEvents.find((e) => isOurs(e.description, spec.key));
  const sameTitle = ctx.orgEvents.find((e) => e.title === spec.title && e !== found);
  if (!found && sameTitle) {
    warn(`"${spec.title}" exists but is not a demo item (${sameTitle.id}); leaving it alone.`);
  }

  if (CLEANUP) {
    if (!found) return void entry.actions.push('not found');
    entry.id = found.id;
    if (['ARCHIVED', 'CANCELLED', 'COMPLETED'].includes(found.status)) {
      entry.actions.push(`already ${found.status}`);
      return;
    }
    if (!DRY_RUN) {
      await call('POST', `/admin/events/${found.id}/status`, {
        token: ctx.admin,
        body: { status: 'ARCHIVED' },
      });
    }
    entry.actions.push(DRY_RUN ? 'would archive' : 'archived');
    console.log(`  ${entry.actions.at(-1)} ${found.id}`);
    return;
  }

  if (!found) {
    if (DRY_RUN) {
      entry.actions.push('would create');
      console.log('  would create');
      return;
    }
    found = await call('POST', '/events', {
      token: ctx.owner,
      idempotencyKey: `qa-demo-event-${spec.key}`,
      body: {
        organizationId: ctx.org.id,
        venueId: venue.id,
        title: spec.title,
        category: spec.category,
        description: description(spec, spec.images),
        isFree: Boolean(spec.isFree),
        ...(spec.ageLimit ? { ageLimit: spec.ageLimit } : {}),
        ...(spec.artists ? { artists: spec.artists } : {}),
      },
    });
    entry.actions.push('created event');
  }
  entry.id = found.id;
  let detail = await call('GET', `/events/${found.id}`, { token: ctx.owner });

  // Session and ticket types, only if the event has none: never a second session.
  if (DRY_RUN) {
    entry.actions.push(
      `status ${detail.status}, ${detail.sessions.length} session(s), ${detail.images.length}/${spec.images.length} image(s)`,
    );
    console.log(`  ${entry.actions.at(-1)}`);
    return;
  }
  if (detail.sessions.length === 0) {
    const startsAt = venueTimeToInstant(spec.date, spec.time, tz);
    const endsAt = new Date(startsAt.getTime() + spec.hours * 3600_000);
    await call('POST', `/events/${found.id}/sessions`, {
      token: ctx.owner,
      body: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
    });
    entry.actions.push(`added session ${spec.date} ${spec.time} ${tz}`);
    detail = await call('GET', `/events/${found.id}`, { token: ctx.owner });
  }
  const session = detail.sessions[0];
  if ((session.ticketTypes ?? []).length === 0) {
    for (const t of spec.tickets) {
      await call('POST', '/events/ticket-types', {
        token: ctx.owner,
        body: {
          eventSessionId: session.id,
          name: t.name,
          priceMinor: t.priceMinor,
          quantityTotal: t.quantityTotal,
          maxPerOrder: t.maxPerOrder ?? 10,
        },
      });
    }
    entry.actions.push(`added ${spec.tickets.length} ticket type(s)`);
  }

  // Images: upload whichever of the planned ones are still missing, in order.
  const have = detail.images.length;
  for (let i = have; i < spec.images.length; i++) {
    const added = await uploadImage(
      ctx.owner,
      found.id,
      spec.images[i],
      `qa-demo-image-${spec.key}-${i}`,
    );
    entry.actions.push(`uploaded image ${spec.images[i]}${added ? ` (${added.id})` : ''}`);
  }

  // Review: submit a draft, then approve it as admin. Nothing else is ever approved here.
  detail = await call('GET', `/events/${found.id}`, { token: ctx.owner });
  if (detail.status === 'DRAFT') {
    const sell = await call('GET', `/events/${found.id}/sellability`, { token: ctx.owner });
    if (sell.sellable === false) {
      warn(
        `${spec.key} is not sellable, left as a draft: ${(sell.blockers ?? []).map((b) => b.message).join(' / ')}`,
      );
    } else {
      await call('POST', `/events/${found.id}/submit`, { token: ctx.owner });
      entry.actions.push('submitted for review');
      detail = await call('GET', `/events/${found.id}`, { token: ctx.owner });
    }
  }
  if (detail.status === 'UNDER_REVIEW' && isOurs(detail.description, spec.key)) {
    await call('POST', `/admin/events/${found.id}/review`, {
      token: ctx.admin,
      body: { decision: 'APPROVE', note: 'QA demo content, approved by scripts/qa-demo.' },
    });
    entry.actions.push('approved as admin');
  }
  entry.status = (await call('GET', `/events/${found.id}`, { token: ctx.owner })).status;
  entry.images = (await call('GET', `/events/${found.id}`, { token: ctx.owner })).images.map(
    (i) => i.id,
  );
  console.log(`  ${entry.actions.join('; ') || 'nothing to do'} -> ${entry.status}`);
}

// ── Films ───────────────────────────────────────────────────────────────────────────

async function seedMovie(ctx, spec) {
  const entry = { key: spec.key, title: spec.title, actions: [], shows: [] };
  report.movies.push(entry);
  console.log(`\n[film] ${spec.title}  (${spec.key})`);

  let movie = null;
  for (const m of ctx.orgMovies.filter((m) => m.title === spec.title)) {
    const full = await call('GET', `/movies/${m.id}`, { token: ctx.owner });
    if (isOurs(full.synopsis, spec.key)) movie = full;
    else warn(`Film "${spec.title}" exists but is not a demo item (${m.id}); leaving it alone.`);
  }

  if (CLEANUP) {
    if (!movie) return void entry.actions.push('not found');
    entry.id = movie.id;
    const shows = await call('GET', `/movies/${movie.id}/shows`, { token: ctx.owner });
    for (const s of shows) {
      if (s.status === 'SCHEDULED' && new Date(s.startsAt) > new Date()) {
        if (!DRY_RUN) {
          await call('POST', `/shows/${s.sessionId}/cancel`, {
            token: ctx.owner,
            body: { reason: 'QA demo content removed by scripts/qa-demo cleanup.' },
          });
        }
        entry.actions.push(`${DRY_RUN ? 'would cancel' : 'cancelled'} show ${s.sessionId}`);
      }
    }
    for (const eventId of new Set(shows.map((s) => s.eventId))) {
      if (!DRY_RUN) {
        await call('POST', `/admin/events/${eventId}/status`, {
          token: ctx.admin,
          body: { status: 'ARCHIVED' },
        });
      }
      entry.actions.push(`${DRY_RUN ? 'would archive' : 'archived'} listing ${eventId}`);
    }
    if (movie.status !== 'ARCHIVED') {
      if (!DRY_RUN) {
        await call('POST', `/movies/${movie.id}/status`, {
          token: ctx.owner,
          body: { status: 'ARCHIVED' },
        });
      }
      entry.actions.push(DRY_RUN ? 'would archive film' : 'archived film');
    }
    console.log(`  ${entry.actions.join('; ') || 'nothing to do'}`);
    return;
  }

  if (!movie) {
    if (DRY_RUN) {
      entry.actions.push('would create');
      console.log('  would create');
      return;
    }
    movie = await call('POST', '/movies', {
      token: ctx.owner,
      body: {
        organizationId: ctx.org.id,
        title: spec.title,
        synopsis: description(spec, [spec.poster]).replace(
          DEMO_MARKER,
          `${DEMO_MARKER} Not a real film.`,
        ),
        runtimeMinutes: spec.runtimeMinutes,
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
      token: ctx.owner,
      body: { status: 'PUBLISHED' },
    });
    entry.actions.push('published film');
  }

  // Shows on the Andhra Pradesh screen. Each planned slot is scheduled once; a slot that
  // collides with someone else's show moves a day later rather than displacing anything.
  let shows = await call('GET', `/movies/${movie.id}/shows`, { token: ctx.owner });
  const ours = shows.filter((s) => s.screenId === ctx.screen.id && s.status !== 'CANCELLED');
  for (const slot of spec.shows.slice(ours.length)) {
    let scheduled = null;
    for (let shift = 0; shift < 5 && !scheduled; shift++) {
      const day = new Date(`${slot.date}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + shift);
      const startsAt = venueTimeToInstant(day.toISOString().slice(0, 10), slot.time, VENUES.vja.tz);
      const endsAt = new Date(startsAt.getTime() + spec.runtimeMinutes * 60000);
      try {
        scheduled = await call('POST', `/movies/${movie.id}/shows`, {
          token: ctx.owner,
          body: {
            screenId: ctx.screen.id,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
          },
        });
        entry.actions.push(`scheduled ${startsAt.toISOString()}`);
      } catch (err) {
        if (err.status !== 409) throw err;
        warn(`${spec.key}: ${slot.date} ${slot.time} is taken on the screen; trying a day later.`);
      }
    }
    if (!scheduled) warn(`${spec.key}: no free slot found near ${slot.date} ${slot.time}.`);
  }
  shows = await call('GET', `/movies/${movie.id}/shows`, { token: ctx.owner });
  const mine = shows.filter((s) => s.screenId === ctx.screen.id);
  entry.shows = mine.map((s) => ({ sessionId: s.sessionId, startsAt: s.startsAt }));
  const eventId = mine[0]?.eventId;
  entry.listingEventId = eventId;

  // The poster: uploaded to the film's own listing and served by the API, so the catalogue
  // never hotlinks a third-party host that can change or vanish.
  if (eventId) {
    let listing = await call('GET', `/events/${eventId}`, { token: ctx.owner });
    if (listing.images.length === 0) {
      await uploadImage(ctx.owner, eventId, spec.poster, `qa-demo-poster-${spec.key}`);
      entry.actions.push(`uploaded poster ${spec.poster}`);
      listing = await call('GET', `/events/${eventId}`, { token: ctx.owner });
    }
    const poster = listing.images[0];
    if (poster && !movie.posterUrl) {
      const posterUrl = `${API}/public/events/${eventId}/images/${poster.id}/full`;
      await call('PATCH', `/movies/${movie.id}`, { token: ctx.owner, body: { posterUrl } });
      entry.actions.push('set posterUrl');
    }
    entry.posterImageId = poster?.id;
  }
  console.log(`  ${entry.actions.join('; ') || 'nothing to do'}`);
}

// ── Main ────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`QA demo ${report.mode} against ${API}`);
  const owner = await login(
    process.env.QA_DEMO_OWNER_EMAIL ?? 'owner@eticketsgo.test',
    process.env.QA_DEMO_OWNER_PASSWORD ?? 'Password123!',
  );
  const admin = await login(
    process.env.QA_DEMO_ADMIN_EMAIL ?? 'admin@eticketsgo.test',
    process.env.QA_DEMO_ADMIN_PASSWORD ?? 'Password123!',
  );

  const orgs = await call('GET', '/organizations', { token: owner });
  const org = (Array.isArray(orgs) ? orgs : (orgs.items ?? [])).find(
    (o) => o.name === ORGANIZATION_NAME,
  );
  if (!org) throw new Error(`The owner account is not a member of "${ORGANIZATION_NAME}".`);

  const venueRows = await call('GET', `/venues?organizationId=${org.id}`, { token: owner });
  const venues = new Map();
  for (const [key, want] of Object.entries(VENUES)) {
    const row = venueRows.find((v) => v.name === want.name);
    if (!row) throw new Error(`QA venue "${want.name}" was not found; nothing was created.`);
    if (/telangana/i.test(row.region ?? '')) {
      throw new Error(`"${want.name}" is in Telangana; the demo set must not use it.`);
    }
    venues.set(key, row);
  }

  const cinemas = await call('GET', `/cinemas?organizationId=${org.id}`, { token: owner });
  const cinema = cinemas.find((c) => c.name === CINEMA.name);
  if (!cinema) throw new Error(`QA cinema "${CINEMA.name}" was not found.`);
  if (!/andhra pradesh/i.test(cinema.region ?? '')) {
    throw new Error(`"${CINEMA.name}" is not recorded as Andhra Pradesh; refusing to schedule.`);
  }
  const screen = (cinema.screens ?? []).find((s) => s.name === CINEMA.screen);
  if (!screen) throw new Error(`Screen "${CINEMA.screen}" was not found at ${CINEMA.name}.`);

  const ctx = {
    owner,
    admin,
    org,
    venues,
    screen,
    orgEvents: await call('GET', `/events?organizationId=${org.id}`, { token: owner }),
    orgMovies: await call('GET', `/movies?organizationId=${org.id}`, { token: owner }),
  };

  for (const spec of EVENTS.filter(selected)) {
    try {
      await seedEvent(ctx, spec);
    } catch (err) {
      warn(`${spec.key}: ${err.message}`);
    }
  }
  for (const spec of MOVIES.filter(selected)) {
    try {
      await seedMovie(ctx, spec);
    } catch (err) {
      warn(`${spec.key}: ${err.message}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  const out = option('--report');
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `\nDone: ${report.events.length} events, ${report.movies.length} films, ${report.warnings.length} warning(s).`,
  );
  if (report.warnings.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
