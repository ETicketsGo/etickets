import { describe, expect, it } from 'vitest';
import type { SeatingRoom } from '@eticketsgo/web-kit';
import { roomsAtVenue } from './seating-model';

const room = (id: string, venueId: string | null): SeatingRoom => ({
  id,
  name: id,
  venueName: venueId ?? '-',
  venueId,
  layoutId: `${id}-layout`,
  layoutName: 'Layout',
  layoutKind: 'GRID',
  sellableSeats: 10,
});

describe('roomsAtVenue', () => {
  /*
    The sessions page offered every space in the organization: on QA an event at a Bengaluru
    hall listed twenty spaces in Boise, Hyderabad and Vijayawada.
  */
  it("offers only the event's venue's spaces", () => {
    const rooms = [room('here', 'v1'), room('there', 'v2')];
    expect(roomsAtVenue(rooms, 'v1')?.map((r) => r.id)).toEqual(['here']);
  });

  it('keeps an old space with no venue, which the API cannot place either', () => {
    expect(roomsAtVenue([room('old', null)], 'v1')?.map((r) => r.id)).toEqual(['old']);
  });

  it('offers everything while the event has no venue, and nothing while loading', () => {
    const rooms = [room('a', 'v1'), room('b', 'v2')];
    expect(roomsAtVenue(rooms, null)).toBe(rooms);
    expect(roomsAtVenue(undefined, 'v1')).toBeUndefined();
  });
});
