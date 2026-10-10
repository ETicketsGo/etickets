import { describe, expect, it } from 'vitest';
import {
  eventSaleState,
  foldSaleStates,
  saleStateLabel,
  sessionSaleState,
  type SessionSaleFacts,
  type SessionSaleState,
} from './sale-state';

const NOW = new Date('2026-10-10T12:00:00Z');
const LATER = '2026-10-12T14:00:00Z';

const tt = (id: string, over: Partial<SessionSaleFacts['ticketTypes'][number]> = {}) => ({
  id,
  name: id,
  priceMinor: 15000,
  salesStartAt: null,
  salesEndAt: null,
  zoned: false,
  remaining: 50,
  ...over,
});

const facts = (over: Partial<SessionSaleFacts> = {}): SessionSaleFacts => ({
  sessionId: 's1',
  eventId: 'e1',
  organizationSuspended: false,
  eventStatus: 'PUBLISHED',
  isFree: false,
  sessionStatus: 'SCHEDULED',
  startsAt: LATER,
  seated: true,
  seatCount: 100,
  ticketTypes: [tt('gold'), tt('standard')],
  checkoutBlockers: [],
  region: 'Andhra Pradesh',
  ...over,
});

const unmapped = {
  code: 'SEAT_CLASS_UNMAPPED',
  owner: 'ORGANIZER' as const,
  organizerMessage: 'Seat category Standard needs a regulatory seat class.',
  fixPath: '/organizer/cinemas/c1/readiness#seat-classes',
  subject: 'Standard',
  ticketTypeIds: ['standard'],
};

describe('sessionSaleState', () => {
  it('is SELLING when every active ticket type would be accepted', () => {
    const s = sessionSaleState(facts(), NOW);
    expect(s.state).toBe('SELLING');
    expect(s.reasons).toEqual([]);
    expect(s.openTicketTypeIds).toEqual(['gold', 'standard']);
    expect(s.closedTicketTypeIds).toEqual([]);
    expect(saleStateLabel(s)).toBe('Selling');
  });

  it('is PARTIAL - never Selling - when checkout refuses one category and sells another', () => {
    // The Vijayawada show from QA: Gold mapped and selling, Standard unmapped and refused.
    const s = sessionSaleState(facts({ checkoutBlockers: [unmapped] }), NOW);
    expect(s.state).toBe('PARTIAL');
    expect(s.openTicketTypeIds).toEqual(['gold']);
    expect(s.closedTicketTypeIds).toEqual(['standard']);
    expect(saleStateLabel(s)).toBe('Partly selling: seat classes not mapped');
    expect(s.reasons[0]!.message).toBe(unmapped.organizerMessage);
    expect(s.reasons[0]!.fixPath).toBe(unmapped.fixPath);
  });

  it('is NOT_SELLING when a refusal stops every ticket type, and names the state', () => {
    const s = sessionSaleState(
      facts({
        region: 'Telangana',
        checkoutBlockers: [
          {
            code: 'NO_PRICING_POLICY',
            owner: 'PLATFORM',
            organizerMessage: 'Ticket sales are paused for cinemas in Telangana.',
            fixPath: null,
            ticketTypeIds: ['gold', 'standard'],
          },
        ],
      }),
      NOW,
    );
    expect(s.state).toBe('NOT_SELLING');
    expect(saleStateLabel(s)).toBe('Not selling: Telangana pricing rules not configured');
    expect(s.reasons[0]!.owner).toBe('PLATFORM');
    expect(s.reasons[0]!.fixPath).toBeNull();
  });

  it('never gives a platform refusal a fix path, whatever arrives', () => {
    const s = sessionSaleState(
      facts({
        checkoutBlockers: [
          { ...unmapped, code: 'SOMETHING_NEW', owner: 'PLATFORM', ticketTypeIds: ['gold'] },
        ],
      }),
      NOW,
    );
    expect(s.reasons[0]!.code).toBe('REGULATORY_PRICING_UNRESOLVED');
    expect(s.reasons[0]!.fixPath).toBeNull();
  });

  it.each([
    [{ organizationSuspended: true }, 'Not selling: organizer account suspended'],
    [{ eventStatus: 'DRAFT' }, 'Not selling: draft, not submitted'],
    [{ eventStatus: 'UNDER_REVIEW' }, 'Not selling: waiting for review'],
    [{ eventStatus: 'PAUSED' }, 'Not selling: event paused'],
    [{ eventStatus: 'CANCELLED' }, 'Not selling: event cancelled'],
    [{ film: { id: 'm1', status: 'DRAFT' } }, 'Not selling: film not published'],
    [{ sessionStatus: 'CANCELLED' }, 'Not selling: show cancelled'],
    [{ sessionStatus: 'PAUSED' }, 'Not selling: sales paused'],
    [{ sessionStatus: 'COMPLETED' }, 'Not selling: show ended'],
    [{ startsAt: '2026-10-10T11:59:00Z' }, 'Not selling: show has started'],
    [{ ticketTypes: [] }, 'Not selling: no tickets to sell'],
  ] as [Partial<SessionSaleFacts>, string][])('%o closes the whole show', (over, label) => {
    const s = sessionSaleState(facts({ ...over, checkoutBlockers: [unmapped] }), NOW);
    expect(s.state).toBe('NOT_SELLING');
    expect(s.openTicketTypeIds).toEqual([]);
    expect(saleStateLabel(s)).toBe(label);
    // A show-wide reason is reported alone, as checkout stops at the first refusal.
    expect(s.reasons).toHaveLength(1);
  });

  it('closes a ticket type outside its booking window, inclusive at the close', () => {
    const s = sessionSaleState(
      facts({
        ticketTypes: [
          tt('gold', { salesStartAt: '2026-10-11T00:00:00Z' }),
          tt('standard', { salesEndAt: NOW.toISOString() }),
        ],
      }),
      NOW,
    );
    expect(s.state).toBe('PARTIAL');
    expect(s.closedTicketTypeIds).toEqual(['gold']);
    expect(saleStateLabel(s)).toBe('Partly selling: bookings not open yet');
  });

  it('says sold out for one category as partial, and for all as not selling', () => {
    const one = sessionSaleState(
      facts({ ticketTypes: [tt('gold', { remaining: 0 }), tt('standard')] }),
      NOW,
    );
    expect(one.state).toBe('PARTIAL');
    expect(saleStateLabel(one)).toBe('Partly selling: gold sold out');

    const all = sessionSaleState(
      facts({ ticketTypes: [tt('gold', { remaining: 0 }), tt('standard', { remaining: 0 })] }),
      NOW,
    );
    expect(all.state).toBe('NOT_SELLING');
    expect(saleStateLabel(all)).toBe('Not selling: sold out');
  });

  it('does not read an unknown count as sold out', () => {
    const s = sessionSaleState(facts({ ticketTypes: [tt('gold', { remaining: null })] }), NOW);
    expect(s.state).toBe('SELLING');
  });

  it('closes the priced tickets of a free event and keeps the free ones', () => {
    const s = sessionSaleState(
      facts({ isFree: true, ticketTypes: [tt('free', { priceMinor: 0 }), tt('paid')] }),
      NOW,
    );
    expect(s.state).toBe('PARTIAL');
    expect(s.openTicketTypeIds).toEqual(['free']);
    expect(s.reasons[0]!.code).toBe('FREE_EVENT_HAS_PRICES');
  });

  it('closes seat tickets on a seated show with no seats, but not standing ones', () => {
    const s = sessionSaleState(
      facts({ seatCount: 0, ticketTypes: [tt('seat'), tt('floor', { zoned: true })] }),
      NOW,
    );
    expect(s.state).toBe('PARTIAL');
    expect(s.openTicketTypeIds).toEqual(['floor']);
    expect(saleStateLabel(s)).toBe('Partly selling: no seats on the seat map');
  });

  it('ignores a blocker naming a ticket type the show does not sell', () => {
    const s = sessionSaleState(
      facts({ checkoutBlockers: [{ ...unmapped, ticketTypeIds: ['elsewhere'] }] }),
      NOW,
    );
    // Nothing on this show is closed, so it sells - the reason is still reported.
    expect(s.state).toBe('SELLING');
  });
});

const show = (
  id: string,
  state: SessionSaleState['state'],
  codes: string[] = [],
): SessionSaleState => ({
  sessionId: id,
  eventId: 'e1',
  state,
  reasons: codes.map((code) => ({
    code: code as never,
    text: code.toLowerCase(),
    message: `${code} message`,
    owner: 'ORGANIZER',
    fixPath: null,
    ticketTypeIds: ['x'],
    affectedSessions: 1,
  })),
  openTicketTypeIds: state === 'NOT_SELLING' ? [] : ['y'],
  closedTicketTypeIds: state === 'SELLING' ? [] : ['x'],
});

describe('eventSaleState', () => {
  const ev = (
    sessions: SessionSaleState[],
    over: Partial<{ eventStatus: string; organizationSuspended: boolean }> = {},
  ) =>
    eventSaleState({
      eventId: 'e1',
      eventStatus: 'PUBLISHED',
      organizationSuspended: false,
      sessions,
      ...over,
    });

  it('is SELLING only when every upcoming show is', () => {
    const e = ev([show('a', 'SELLING'), show('b', 'SELLING')]);
    expect(e.state).toBe('SELLING');
    expect(e.reasons).toEqual([]);
    expect(e.sessions).toEqual({ upcoming: 2, selling: 2, partial: 0, notSelling: 0 });
  });

  it('is PARTIAL when one show is partial, even if the rest sell', () => {
    const e = ev([show('a', 'SELLING'), show('b', 'PARTIAL', ['SEAT_CLASS_UNMAPPED'])]);
    expect(e.state).toBe('PARTIAL');
    expect(saleStateLabel(e)).toBe('Partly selling: seat_class_unmapped');
  });

  it('is PARTIAL when some shows sell and others do not', () => {
    const e = ev([show('a', 'SELLING'), show('b', 'NOT_SELLING', ['SESSION_PAUSED'])]);
    expect(e.state).toBe('PARTIAL');
  });

  it('is NOT_SELLING when no upcoming show has anything open', () => {
    const e = ev([
      show('a', 'NOT_SELLING', ['NO_PRICING_POLICY']),
      show('b', 'NOT_SELLING', ['NO_PRICING_POLICY']),
    ]);
    expect(e.state).toBe('NOT_SELLING');
    // One fault on two shows is one reason, counted twice.
    expect(e.reasons).toHaveLength(1);
    expect(e.reasons[0]!.affectedSessions).toBe(2);
  });

  it('leads with the most widespread reason', () => {
    const e = ev([
      show('a', 'NOT_SELLING', ['SESSION_PAUSED']),
      show('b', 'PARTIAL', ['SOLD_OUT']),
      show('c', 'PARTIAL', ['SOLD_OUT']),
    ]);
    expect(e.reasons.map((r) => r.code)).toEqual(['SOLD_OUT', 'SESSION_PAUSED']);
  });

  it('is NOT_SELLING with no upcoming show (empty is never Selling)', () => {
    const e = ev([]);
    expect(e.state).toBe('NOT_SELLING');
    expect(saleStateLabel(e)).toBe('Not selling: no upcoming shows');
  });

  it('puts the lifecycle first: an unpublished event is not selling whatever its shows say', () => {
    const e = ev([show('a', 'SELLING')], { eventStatus: 'DRAFT' });
    expect(saleStateLabel(e)).toBe('Not selling: draft, not submitted');
    expect(ev([show('a', 'SELLING')], { organizationSuspended: true }).state).toBe('NOT_SELLING');
  });

  it('labels an unknown status and an empty reason list without inventing a reason', () => {
    expect(saleStateLabel(ev([show('a', 'SELLING')], { eventStatus: 'SOMETHING' }))).toBe(
      'Not selling: not published',
    );
    expect(saleStateLabel({ state: 'PARTIAL', reasons: [] })).toBe(
      'Partly selling: some tickets are closed',
    );
    expect(saleStateLabel({ state: 'NOT_SELLING', reasons: [] })).toBe(
      'Not selling: checkout would refuse it',
    );
  });
});

describe('foldSaleStates', () => {
  it('folds listings into a film the same way shows fold into an event', () => {
    const a = {
      state: 'PARTIAL' as const,
      reasons: [show('x', 'PARTIAL', ['SOLD_OUT']).reasons[0]!],
    };
    a.reasons[0] = { ...a.reasons[0]!, affectedSessions: 3 };
    const b = {
      state: 'NOT_SELLING' as const,
      reasons: [{ ...a.reasons[0]!, affectedSessions: 2 }],
    };
    const f = foldSaleStates([a, b]);
    expect(f.state).toBe('PARTIAL');
    expect(f.reasons).toHaveLength(1);
    expect(f.reasons[0]!.affectedSessions).toBe(5);
    expect(foldSaleStates([b]).state).toBe('NOT_SELLING');
    expect(foldSaleStates([{ state: 'SELLING', reasons: [] }])).toEqual({
      state: 'SELLING',
      reasons: [],
    });
    expect(foldSaleStates([]).state).toBe('NOT_SELLING');
  });
});
