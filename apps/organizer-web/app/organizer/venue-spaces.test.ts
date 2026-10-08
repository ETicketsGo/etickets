import { describe, expect, it } from 'vitest';
import { groupSpacesByVenue, spaceCapabilityLabel, spaceKindLabel } from './venue-spaces';
import type { Venue, VenueSpace } from '@eticketsgo/web-kit';

/**
 * VENUE -> SPACE -> LAYOUT, assembled correctly.
 *
 * The rule worth testing is the one that is easy to get wrong and invisible when it is: a
 * space must never be dropped from the only page that lists spaces, even when its venue is
 * missing or belongs to another organization.
 */
const venue = (id: string, name = id): Venue => ({ id, name, city: 'Boise' }) as Venue;

const space = (id: string, venueId: string | null, over: Partial<VenueSpace> = {}): VenueSpace =>
  ({
    id,
    venueId,
    name: id,
    capacity: 100,
    status: 'ACTIVE',
    screenType: '2D',
    cinemaId: null,
    cinemaName: null,
    layout: null,
    ...over,
  }) as VenueSpace;

const LAYOUT = { id: 'l1', name: 'Basketball', layoutKind: 'SECTIONED', version: 1 };

describe('grouping spaces under their venue', () => {
  it('puts each space under its own venue', () => {
    const { venues } = groupSpacesByVenue(
      [venue('v1'), venue('v2')],
      [space('a', 'v1'), space('b', 'v2'), space('c', 'v1')],
    );
    expect(venues[0].spaces.map((s) => s.id)).toEqual(['a', 'c']);
    expect(venues[1].spaces.map((s) => s.id)).toEqual(['b']);
  });

  it('keeps a venue with no spaces, because that is not a fault', () => {
    // A lawn, a terrace or a ground sells fine without a drawn space.
    const { venues } = groupSpacesByVenue([venue('v1')], []);
    expect(venues[0].spaces).toEqual([]);
  });

  it('never loses a space whose venue is missing or not visible', () => {
    /*
      Both land in `orphans` rather than being dropped. After the migration this list should
      be empty, which is why it is SHOWN: a non-empty one is evidence of a real problem, and
      hiding it would turn that evidence into a mystery.
    */
    const { venues, orphans } = groupSpacesByVenue(
      [venue('v1')],
      [space('a', 'v1'), space('b', null), space('c', 'belongs-to-another-org')],
    );
    expect(venues[0].spaces.map((s) => s.id)).toEqual(['a']);
    expect(orphans.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('shows every space exactly once, wherever it ends up', () => {
    const all = [space('a', 'v1'), space('b', null), space('c', 'gone'), space('d', 'v2')];
    const { venues, orphans } = groupSpacesByVenue([venue('v1'), venue('v2')], all);
    const shown = [...venues.flatMap((v) => v.spaces), ...orphans].map((s) => s.id).sort();
    expect(shown).toEqual(['a', 'b', 'c', 'd']);
  });

  it('counts the spaces that can actually sell a numbered seat', () => {
    /*
      A space without a published layout cannot sell one. Reporting "2 spaces" when only one
      of them can is how an organizer gets a surprise on sale day.
    */
    const { venues } = groupSpacesByVenue(
      [venue('v1')],
      [space('a', 'v1', { layout: LAYOUT }), space('b', 'v1')],
    );
    expect(venues[0].seatedCount).toBe(1);
  });
});

describe('describing a space in a list', () => {
  it('says when a space is a cinema screen, because that means something to an operator', () => {
    expect(spaceKindLabel(space('s', 'v1', { cinemaName: 'PVR Whitefield' }))).toContain(
      'PVR Whitefield',
    );
  });

  it('calls everything else simply a space', () => {
    // An arena, an auditorium and a concert hall need no separate words to sell seats.
    expect(spaceKindLabel(space('s', 'v1'))).toBe('Space');
  });

  it('says what a space can sell today rather than showing a status code', () => {
    expect(spaceCapabilityLabel(space('s', 'v1'))).toMatch(/general admission only/i);
    // Asserted in parts rather than as one regex: a single pattern spanning the whole string
    // fails on punctuation that has nothing to do with what is being checked.
    const label = spaceCapabilityLabel(space('s', 'v1', { layout: LAYOUT }));
    expect(label).toMatch(/Reserved seating/);
    expect(label).toContain('Basketball');
    expect(label).toContain('blocks');
  });
});
