import { describe, expect, it } from 'vitest';
import type { EventSession, TicketType, VenueSpace } from '@eticketsgo/web-kit';
import {
  filterSessions,
  layoutLabel,
  resolveLayout,
  seatingMix,
  sessionSeating,
  spaceFor,
} from './seating-model';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const DAY = 86_400_000;

function type(name: string, total: number, sold: number, held: number, price = 25_000): TicketType {
  return {
    id: `tt-${name}`,
    name,
    priceMinor: price,
    currency: 'INR',
    quantityTotal: total,
    maxPerOrder: 10,
    salesStartAt: null,
    salesEndAt: null,
    status: 'ACTIVE',
    inventory: { quantityTotal: total, quantitySold: sold, quantityHeld: held },
  };
}

function session(over: Partial<EventSession> = {}): EventSession {
  return {
    id: 's1',
    startsAt: new Date(NOW + 5 * DAY).toISOString(),
    endsAt: new Date(NOW + 5 * DAY + 3 * 3_600_000).toISOString(),
    status: 'SCHEDULED',
    screenId: 'scr1',
    seatMapId: 'map-v3',
    screen: { name: 'Main Hall', venue: { name: 'Old Mill' }, cinema: null },
    ticketTypes: [type('Stalls', 80, 0, 0), type('Balcony', 20, 0, 0, 40_000)],
    ...over,
  };
}

const space: VenueSpace = {
  id: 'scr1',
  name: 'Main Hall',
  capacity: 100,
  status: 'ACTIVE',
  screenType: '2D',
  cinemaId: null,
  cinemaName: null,
  layouts: [{ id: 'map-v4', name: 'Concert', layoutKind: 'GRID', version: 4 }],
  layout: { id: 'map-v4', name: 'Concert', layoutKind: 'GRID', version: 4 },
};
const v3 = { id: 'map-v3', name: 'Concert', version: 3, status: 'PUBLISHED' };

describe('sessionSeating', () => {
  it('says the space, the pinned version and a newer one, and allows a change while unsold', () => {
    const newer = { id: 'map-v4', name: 'Concert v4', version: 4, status: 'PUBLISHED' };
    const s = sessionSeating({ session: session(), space, layout: v3, newer, now: NOW });
    expect(s.kind).toBe('reserved');
    expect(s.place).toBe('Old Mill, Main Hall');
    expect(s.layout?.version).toBe(3);
    expect(s.newer?.version).toBe(4);
    expect(s.owner).toEqual({ kind: 'space', layoutsHref: '/organizer/spaces/scr1/layouts' });
    expect(s.counts).toEqual({ capacity: 100, sold: 0, held: 0, available: 100 });
    expect(s.change).toEqual({ allowed: true });
  });

  it('locks the layout after a sale and says to which version, in words', () => {
    const s = sessionSeating({
      session: session({ ticketTypes: [type('Stalls', 80, 2, 1), type('Balcony', 20, 0, 0)] }),
      space,
      layout: v3,
      now: NOW,
    });
    expect(s.change).toEqual({
      allowed: false,
      reason:
        '2 seats have been sold for this show, so its layout is locked to Concert, version 3. Create a new show to use a different layout.',
    });
    expect(s.counts).toEqual({ capacity: 100, sold: 2, held: 1, available: 97 });
    // The server refuses a price change once a category has sold.
    expect(s.categories.map((c) => c.priceLocked)).toEqual([true, false]);
  });

  it('locks while a checkout holds a seat, and says it is temporary', () => {
    const s = sessionSeating({
      session: session({ ticketTypes: [type('Stalls', 80, 0, 1)] }),
      space,
      layout: v3,
      now: NOW,
    });
    expect(s.change.allowed).toBe(false);
    if (!s.change.allowed) expect(s.change.reason).toMatch(/^1 seat is held in a checkout/);
  });

  it('keeps an ended or cancelled show as it was', () => {
    const ended = session({
      startsAt: new Date(NOW - 2 * DAY).toISOString(),
      endsAt: new Date(NOW - DAY).toISOString(),
    });
    const r = sessionSeating({ session: ended, space, layout: v3, now: NOW }).change;
    expect(r).toEqual({
      allowed: false,
      reason: 'This show has ended, so its seating stays as it was.',
    });
    const cancelled = sessionSeating({
      session: session({ status: 'CANCELLED' }),
      space,
      layout: v3,
      now: NOW,
    }).change;
    expect(cancelled.allowed).toBe(false);
  });

  it('names the cinema that owns a screen and links to its layouts', () => {
    const cinemaSpace = { ...space, cinemaId: 'cin1', cinemaName: 'PVR Phoenix' };
    const s = sessionSeating({ session: session(), space: cinemaSpace, layout: v3, now: NOW });
    expect(s.owner).toEqual({
      kind: 'cinema',
      name: 'PVR Phoenix',
      cinemaId: 'cin1',
      layoutsHref: '/organizer/cinemas/cin1/screens/scr1/layouts',
    });
  });

  it('describes general admission with no space or layout', () => {
    const ga = session({
      screenId: null,
      seatMapId: null,
      screen: null,
      ticketTypes: [type('GA', 50, 5, 0)],
    });
    const s = sessionSeating({ session: ga, space: null, layout: null, now: NOW });
    expect(s.kind).toBe('ga');
    expect(s.place).toBeNull();
    expect(s.change).toEqual({
      allowed: false,
      reason:
        '5 tickets have been sold for this show, so it stays general admission. Create a new show to sell numbered seats.',
    });
  });
});

describe('resolveLayout', () => {
  const rows = [
    { id: 'v1', name: 'Concert', version: 1, status: 'ARCHIVED', clonedFromId: null },
    { id: 'v3', name: 'Concert', version: 3, status: 'PUBLISHED', clonedFromId: 'v1' },
    // Cloning names the copy; lineage, not the name, says it supersedes v3.
    { id: 'v4', name: 'Concert v4', version: 4, status: 'PUBLISHED', clonedFromId: 'v3' },
    { id: 'v5', name: 'Concert v5', version: 5, status: 'DRAFT', clonedFromId: 'v4' },
    { id: 'b1', name: 'Basketball', version: 6, status: 'PUBLISHED', clonedFromId: null },
  ];

  it('names the pinned version and the newest PUBLISHED descendant', () => {
    const r = resolveLayout('v3', rows);
    expect(r.layout).toEqual({ id: 'v3', name: 'Concert', version: 3, status: 'PUBLISHED' });
    // Not the draft v5, and not the unrelated Basketball configuration.
    expect(r.newer?.id).toBe('v4');
  });

  it('finds descendants through more than one clone', () => {
    expect(resolveLayout('v1', rows).newer?.id).toBe('v4');
  });

  it('has nothing newer for the latest, and falls back when the list is missing', () => {
    expect(resolveLayout('v4', rows).newer).toBeNull();
    expect(resolveLayout('v3', undefined, v3).layout?.version).toBe(3);
    expect(resolveLayout(null, rows)).toEqual({ layout: null, newer: null });
  });

  it('finds the space by the session screen', () => {
    expect(spaceFor({ screenId: 'scr1' }, [space])?.id).toBe('scr1');
    expect(spaceFor({ screenId: null }, [space])).toBeNull();
  });
});

describe('labels and lists', () => {
  it('says a default-named layout by version only', () => {
    expect(layoutLabel({ id: 'x', name: 'Default', version: 2 })).toBe('version 2');
    expect(layoutLabel({ id: 'x', name: 'Basketball', version: 1 })).toBe('Basketball, version 1');
    expect(layoutLabel(null)).toBe('its current layout');
  });

  it('summarises the mix and filters upcoming from past', () => {
    const ga = session({ id: 'ga', screenId: null });
    const past = session({
      id: 'past',
      startsAt: new Date(NOW - DAY).toISOString(),
      endsAt: new Date(NOW - DAY + 3_600_000).toISOString(),
    });
    expect(seatingMix([session(), ga, session({ status: 'CANCELLED' })])).toBe(
      '1 reserved seating, 1 general admission',
    );
    expect(filterSessions([past, session()], 'upcoming', NOW).map((s) => s.id)).toEqual(['s1']);
    expect(filterSessions([past, session()], 'past', NOW).map((s) => s.id)).toEqual(['past']);
  });
});
