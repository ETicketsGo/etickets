import { describe, expect, it } from 'vitest';
import type { Cinema, Venue } from '@eticketsgo/web-kit';
import { groupRoomsByVenue, screenCount } from './venue-rooms';

/**
 * Rooms, under the venue they belong to.
 *
 * ── WHAT THIS PAGE REPLACED ────────────────────────────────────────────────────────
 * Venues and rooms were two sidebar sections, and setting up one site meant crossing
 * between them. Worse, creating a room without naming a venue makes one, named after the
 * room — so an organizer saw the same name in both lists as two unrelated things, with
 * nothing anywhere to say why.
 *
 * The grouping is what makes that visible. The tests that matter most are the ones about
 * rooms that DON'T group cleanly, because those are the ones a naive version drops.
 */

const venue = (id: string, name: string): Venue => ({
  id,
  name,
  city: 'Hyderabad',
  country: 'India',
  region: 'Telangana',
  timezone: 'Asia/Kolkata',
  address: null,
  capacity: null,
});

const room = (id: string, venueId: string | null, screens = 1): Cinema =>
  ({
    id,
    name: `Room ${id}`,
    city: 'Hyderabad',
    status: 'ACTIVE',
    timezone: 'Asia/Kolkata',
    venueId,
    screens: Array.from({ length: screens }, (_, i) => ({ id: `${id}-s${i}` })),
  }) as unknown as Cinema;

describe('grouping rooms under venues', () => {
  it('puts each room under its own venue', () => {
    const { venues } = groupRoomsByVenue(
      [venue('v1', 'PVR Banjara'), venue('v2', 'INOX GVK')],
      [room('a', 'v1'), room('b', 'v2'), room('c', 'v1')],
    );
    expect(venues[0].rooms.map((r) => r.id)).toEqual(['a', 'c']);
    expect(venues[1].rooms.map((r) => r.id)).toEqual(['b']);
  });

  it('keeps a venue with no rooms, because that is not a fault', () => {
    // A lawn, a ground, a terrace. Selling general admission needs no room at all.
    const { venues } = groupRoomsByVenue([venue('v1', 'Open Grounds')], []);
    expect(venues).toHaveLength(1);
    expect(venues[0].rooms).toEqual([]);
  });

  it('never loses a room that belongs to no venue', () => {
    /*
      `venueId` is nullable and rows predate the column. A room the organizer can see in
      their own data vanishing from the only page that lists rooms would be a worse bug than
      the one this page was built to fix.
    */
    const { venues, orphans } = groupRoomsByVenue([venue('v1', 'PVR')], [room('a', null)]);
    expect(orphans.map((r) => r.id)).toEqual(['a']);
    expect(venues[0].rooms).toEqual([]);
  });

  it('never loses a room pointing at a venue that is not in the list', () => {
    // Grouping on the id alone would file this under a key nothing renders — a silent drop.
    const { orphans } = groupRoomsByVenue([venue('v1', 'PVR')], [room('a', 'v-deleted')]);
    expect(orphans.map((r) => r.id)).toEqual(['a']);
  });

  it('shows every room exactly once, wherever it ends up', () => {
    // The invariant behind the three tests above, asserted directly.
    const rooms = [room('a', 'v1'), room('b', null), room('c', 'gone'), room('d', 'v2')];
    const { venues, orphans } = groupRoomsByVenue([venue('v1', 'A'), venue('v2', 'B')], rooms);
    const shown = [...venues.flatMap((v) => v.rooms), ...orphans].map((r) => r.id).sort();
    expect(shown).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves venue order to the server rather than re-sorting it', () => {
    const { venues } = groupRoomsByVenue([venue('v2', 'Zed'), venue('v1', 'Alpha')], []);
    expect(venues.map((v) => v.venue.id)).toEqual(['v2', 'v1']);
  });

  it('handles an organization with nothing set up at all', () => {
    const { venues, orphans } = groupRoomsByVenue([], []);
    expect(venues).toEqual([]);
    expect(orphans).toEqual([]);
  });
});

describe('screen count', () => {
  it('counts the screens a room has', () => {
    expect(screenCount(room('a', 'v1', 3))).toBe(3);
  });

  it('reports zero rather than throwing when screens were not loaded', () => {
    // A room with no screens has no seat map and cannot sell a numbered seat — which is
    // invisible from the name, and is exactly why the count is shown at all.
    expect(screenCount({ ...room('a', 'v1'), screens: undefined } as Cinema)).toBe(0);
  });
});
