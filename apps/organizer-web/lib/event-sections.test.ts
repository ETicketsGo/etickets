import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_SECTIONS, resolveEventLocation, segmentOf, visibleSections } from './event-sections';

/**
 * The event navigation's sections, and the promise that regrouping them took nothing away.
 *
 * The route list is read from the app directory itself rather than typed out here: a new page
 * added under `events/[id]` with no section would otherwise be reachable only by URL, and a
 * mirrored list in this file would happily agree with the mistake.
 */

const EVENT_DIR = join(__dirname, '..', 'app', 'organizer', 'events', '[id]');
const ROUTES = [
  '',
  ...readdirSync(EVENT_DIR)
    .filter((name) => statSync(join(EVENT_DIR, name)).isDirectory())
    .map((name) => `/${name}`),
];
const BASE = '/organizer/events/evt_123';
const ALL_SEGS = EVENT_SECTIONS.flatMap((s) => s.pages.map((p) => p.seg));

describe('event sections', () => {
  it('has at most seven top-level sections', () => {
    expect(EVENT_SECTIONS.length).toBeLessThanOrEqual(7);
    expect(EVENT_SECTIONS.map((s) => s.label)).toEqual([
      'Overview',
      'Tickets & seating',
      'Bookings & attendees',
      'Promotion',
      'Check-in',
      'Reports',
      'Settings',
    ]);
  });

  it('finds the routes on disk (guards the test itself)', () => {
    // If the directory read silently found nothing, every assertion below would pass vacuously.
    expect(ROUTES).toContain('/tickets');
    expect(ROUTES).toContain('/reconciliation');
    expect(ROUTES.length).toBeGreaterThanOrEqual(15);
  });

  it('maps every existing route to exactly one section', () => {
    for (const route of ROUTES) {
      const owners = EVENT_SECTIONS.filter((s) => s.pages.some((p) => p.seg === route));
      expect({ route, owners: owners.map((s) => s.key) }).toEqual({
        route,
        owners: [expect.any(String)],
      });
    }
  });

  it('names no page that does not exist', () => {
    // A section entry with no route behind it is a link to a 404.
    for (const seg of ALL_SEGS) expect(ROUTES).toContain(seg);
    expect(new Set(ALL_SEGS).size).toBe(ALL_SEGS.length);
  });

  it('puts the expected pages in each section', () => {
    const pages = (key: string) =>
      EVENT_SECTIONS.find((s) => s.key === key)!.pages.map((p) => p.seg);
    expect(pages('overview')).toEqual(['']);
    expect(pages('tickets')).toEqual(['/sessions', '/tickets', '/commerce']);
    expect(pages('bookings')).toEqual(['/orders', '/attendees']);
    expect(pages('promotion')).toEqual(['/promote']);
    expect(pages('checkin')).toEqual([
      '/checkin',
      '/command-center',
      '/devices',
      '/preflight',
      '/reconciliation',
    ]);
    expect(pages('reports')).toEqual(['/reports', '/assistant']);
    expect(pages('settings')).toEqual(['/edit']);
  });
});

describe('resolving where you are', () => {
  it('resolves the overview from the bare event path, with or without a trailing slash', () => {
    expect(resolveEventLocation(BASE, BASE)?.section.key).toBe('overview');
    expect(resolveEventLocation(`${BASE}/`, BASE)?.section.key).toBe('overview');
  });

  it('resolves every route to its section and page', () => {
    for (const route of ROUTES) {
      const found = resolveEventLocation(`${BASE}${route}`, BASE);
      expect(found?.page.seg).toBe(route);
    }
    expect(resolveEventLocation(`${BASE}/orders`, BASE)?.section.label).toBe(
      'Bookings & attendees',
    );
    expect(resolveEventLocation(`${BASE}/commerce`, BASE)?.section.label).toBe('Tickets & seating');
    expect(resolveEventLocation(`${BASE}/assistant`, BASE)?.section.label).toBe('Reports');
    expect(resolveEventLocation(`${BASE}/edit`, BASE)?.section.label).toBe('Settings');
  });

  it('keeps a deeper path inside the page it starts with', () => {
    expect(segmentOf(`${BASE}/tickets/anything/else`, BASE)).toBe('/tickets');
    expect(resolveEventLocation(`${BASE}/tickets/anything`, BASE)?.section.key).toBe('tickets');
  });

  it('does not claim a path outside this event', () => {
    // `evt_1234` starts with `evt_123`; a bare prefix check would have claimed it.
    expect(segmentOf('/organizer/events/evt_1234/tickets', BASE)).toBeNull();
    expect(resolveEventLocation('/organizer/events', BASE)).toBeNull();
    expect(resolveEventLocation(`${BASE}/no-such-page`, BASE)).toBeNull();
  });
});

describe('offline consoles', () => {
  const offlineSegs = ['/command-center', '/devices', '/preflight', '/reconciliation'];
  const shown = (sections: ReturnType<typeof visibleSections>) =>
    sections.flatMap((s) => s.pages.map((p) => p.seg));

  it('hides them when offline check-in is off', () => {
    // Their endpoints 404 without the flag, so offering them would be a dead end.
    const segs = shown(visibleSections(false, '/checkin'));
    for (const seg of offlineSegs) expect(segs).not.toContain(seg);
  });

  it('shows every page when offline check-in is on', () => {
    expect(shown(visibleSections(true, '')).sort()).toEqual([...ALL_SEGS].sort());
  });

  it('keeps the page you are on, even with the flag off', () => {
    // Arriving at one by link and finding no trace of it in the navigation reads as being lost.
    const segs = shown(visibleSections(false, '/devices'));
    expect(segs).toContain('/devices');
    expect(segs).not.toContain('/preflight');
  });

  it('never leaves a section empty', () => {
    for (const section of visibleSections(false, null)) {
      expect(section.pages.length).toBeGreaterThan(0);
    }
  });
});
