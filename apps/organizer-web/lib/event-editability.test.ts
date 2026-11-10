import { describe, expect, it } from 'vitest';
import {
  canEditEvents,
  datesSummary,
  editLabel,
  eventDetailsEditability,
  eventSalesFacts,
  freePaidEditability,
  imagesEditability,
  sessionTimeEditability,
  ticketPriceEditability,
  type EventSalesFacts,
} from './event-editability';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const HOUR = 3_600_000;
const iso = (offsetHours: number) => new Date(NOW + offsetHours * HOUR).toISOString();
const NO_SALES: EventSalesFacts = { sold: 0, held: 0, pricedTicketTypes: 0 };

const ASCII = /^[\x20-\x7e]*$/;

describe('eventDetailsEditability', () => {
  it('a draft is editable now', () => {
    const v = eventDetailsEditability({ status: 'DRAFT', canEdit: true });
    expect(v.kind).toBe('editable');
  });

  it('under review is editable, and the review sees the latest save', () => {
    const v = eventDetailsEditability({ status: 'UNDER_REVIEW', canEdit: true });
    expect(v.kind).toBe('editable');
    expect(v.note).toMatch(/review/);
  });

  it('a published event is locked, says to pause, and that dates and tickets still change', () => {
    const v = eventDetailsEditability({ status: 'PUBLISHED', canEdit: true });
    expect(v.kind).toBe('locked');
    expect(v.note).toMatch(/Pause sales/);
    expect(v.note).toMatch(/Dates and tickets can still change/);
  });

  it('a paused event is editable but may go back to review', () => {
    const v = eventDetailsEditability({ status: 'PAUSED', canEdit: true });
    expect(v.kind).toBe('review');
    expect(v.note).toMatch(/may go back to our team for review/);
  });

  it('a paused event with edits already made says it will be reviewed', () => {
    const v = eventDetailsEditability({
      status: 'PAUSED',
      canEdit: true,
      needsReviewOnResume: true,
    });
    expect(v.kind).toBe('review');
    expect(v.note).toMatch(/already changed reviewed details/);
  });

  it('a pause by the platform team says only they can resume it', () => {
    const v = eventDetailsEditability({ status: 'PAUSED', canEdit: true, pausedByAdmin: true });
    expect(v.note).toMatch(/only they can resume/);
  });

  it.each(['SOLD_OUT', 'CANCELLED', 'COMPLETED', 'ARCHIVED'])('%s is locked', (status) => {
    expect(eventDetailsEditability({ status, canEdit: true }).kind).toBe('locked');
  });

  it('a member who may not edit is locked whatever the status', () => {
    const v = eventDetailsEditability({ status: 'DRAFT', canEdit: false });
    expect(v.kind).toBe('locked');
    expect(v.note).toMatch(/owner or a manager/);
  });
});

describe('canEditEvents', () => {
  it('owners and managers, and a missing role (platform admin)', () => {
    expect(canEditEvents('ORGANIZER_OWNER')).toBe(true);
    expect(canEditEvents('ORGANIZER_MANAGER')).toBe(true);
    expect(canEditEvents(null)).toBe(true);
    expect(canEditEvents(undefined)).toBe(true);
    expect(canEditEvents('ORGANIZER_STAFF')).toBe(false);
  });
});

describe('imagesEditability', () => {
  it('changes while on sale, without review', () => {
    expect(imagesEditability({ status: 'PUBLISHED', canEdit: true }).kind).toBe('editable');
  });
  it('locks once the event is over', () => {
    expect(imagesEditability({ status: 'COMPLETED', canEdit: true }).note).toMatch(/over/);
  });
});

describe('eventSalesFacts', () => {
  it('sums sold and held, and counts priced ticket types', () => {
    const facts = eventSalesFacts([
      {
        ticketTypes: [
          { priceMinor: 500, inventory: { quantitySold: 2, quantityHeld: 1 } },
          { priceMinor: 0, inventory: null },
        ],
      },
      { ticketTypes: [{ priceMinor: 900, inventory: { quantitySold: 0, quantityHeld: 3 } }] },
      {},
    ]);
    expect(facts).toEqual({ sold: 2, held: 4, pricedTicketTypes: 2 });
  });
});

describe('freePaidEditability', () => {
  const draft = eventDetailsEditability({ status: 'DRAFT', canEdit: true });
  const published = eventDetailsEditability({ status: 'PUBLISHED', canEdit: true });
  const paused = eventDetailsEditability({ status: 'PAUSED', canEdit: true });

  it('draft, free, nobody booked: editable', () => {
    const v = freePaidEditability({
      details: draft,
      isFree: true,
      facts: NO_SALES,
      bookingsOnFile: 0,
    });
    expect(v.kind).toBe('editable');
  });

  it('published with no sales: locked by the status, not by sales', () => {
    const v = freePaidEditability({
      details: published,
      isFree: false,
      facts: NO_SALES,
      bookingsOnFile: 0,
    });
    expect(v.kind).toBe('locked');
    expect(v.note).toMatch(/on sale/);
  });

  it('paused with sales: locked, and says what to do instead', () => {
    const v = freePaidEditability({
      details: paused,
      isFree: false,
      facts: { sold: 3, held: 0, pricedTicketTypes: 1 },
      bookingsOnFile: 3,
    });
    expect(v.kind).toBe('locked');
    expect(v.note).toBe(
      '3 tickets have been sold, so this event cannot be switched between free and paid. To sell it the other way, add a new event.',
    );
  });

  it('a checkout in progress locks it for now', () => {
    const v = freePaidEditability({
      details: draft,
      isFree: true,
      facts: { sold: 0, held: 1, pricedTicketTypes: 0 },
      bookingsOnFile: 1,
    });
    expect(v.kind).toBe('locked');
    expect(v.note).toMatch(/1 ticket is held/);
  });

  it('paid with priced ticket types: turning free is refused until they are zero', () => {
    const v = freePaidEditability({
      details: draft,
      isFree: false,
      facts: { sold: 0, held: 0, pricedTicketTypes: 2 },
      bookingsOnFile: 0,
    });
    expect(v.kind).toBe('locked');
    expect(v.note).toMatch(/all 2 priced ticket types to zero/);
  });

  it('paid with no priced ticket types can become free', () => {
    const v = freePaidEditability({
      details: draft,
      isFree: false,
      facts: NO_SALES,
      bookingsOnFile: 0,
    });
    expect(v.kind).toBe('editable');
  });

  it('cancelled bookings on file: offered, with the possible refusal said', () => {
    const v = freePaidEditability({
      details: paused,
      isFree: true,
      facts: NO_SALES,
      bookingsOnFile: 2,
    });
    expect(v.kind).toBe('review');
    expect(v.note).toMatch(/payment, receipt or refund/);
  });
});

describe('ticketPriceEditability', () => {
  it('free: locked at zero', () => {
    expect(ticketPriceEditability({ isFree: true, sold: 0, held: 0 }).kind).toBe('locked');
  });
  it('paid with sales: locked, with the way forward', () => {
    const v = ticketPriceEditability({ isFree: false, sold: 1, held: 0 });
    expect(v.kind).toBe('locked');
    expect(v.note).toMatch(/add a new ticket type and deactivate this one/);
  });
  it('paid with only holds: editable, new checkouts only', () => {
    const v = ticketPriceEditability({ isFree: false, sold: 0, held: 2 });
    expect(v.kind).toBe('editable');
    expect(v.note).toMatch(/new checkouts only/);
  });
  it('paid with nothing sold: editable', () => {
    expect(ticketPriceEditability({ isFree: false, sold: 0, held: 0 }).kind).toBe('editable');
  });
});

describe('sessionTimeEditability', () => {
  const future = { status: 'SCHEDULED', startsAt: iso(48), endsAt: iso(51), sold: 0, held: 0 };

  it('a future date nobody booked: editable', () => {
    expect(sessionTimeEditability(future, NOW, false).kind).toBe('editable');
  });

  it('a paused date nobody booked: editable (the server does not refuse it)', () => {
    expect(sessionTimeEditability({ ...future, status: 'PAUSED' }, NOW, false).kind).toBe(
      'editable',
    );
  });

  it('sold, paid event: locked, cancel refunds and tells buyers', () => {
    const v = sessionTimeEditability({ ...future, sold: 3 }, NOW, false);
    expect(v).toEqual({
      kind: 'locked',
      note: 'Time locked: 3 tickets sold. Buyers chose this time. To move it, cancel this session (buyers are refunded and told) and add a new one.',
    });
  });

  it('sold, free event: no refund promised', () => {
    const v = sessionTimeEditability({ ...future, sold: 1 }, NOW, true);
    expect(v.note).toMatch(/1 ticket sold/);
    expect(v.note).toMatch(/attendees are told/);
    expect(v.note).not.toMatch(/refund/);
  });

  it('held: locked for now', () => {
    expect(sessionTimeEditability({ ...future, held: 2 }, NOW, false).note).toMatch(
      /2 tickets are in a checkout/,
    );
  });

  it('started: says so', () => {
    const v = sessionTimeEditability({ ...future, startsAt: iso(-1), endsAt: iso(2) }, NOW, false);
    expect(v.kind).toBe('locked');
    expect(v.note).toMatch(/already started/);
  });

  it('past: over', () => {
    const v = sessionTimeEditability({ ...future, startsAt: iso(-5), endsAt: iso(-2) }, NOW, false);
    expect(v.note).toBe('This session is over.');
  });

  it('completed or cancelled: locked', () => {
    expect(sessionTimeEditability({ ...future, status: 'COMPLETED' }, NOW, false).note).toBe(
      'This session is over.',
    );
    expect(sessionTimeEditability({ ...future, status: 'CANCELLED' }, NOW, false).note).toBe(
      'This session is cancelled.',
    );
  });
});

describe('datesSummary', () => {
  it('none yet', () => {
    expect(datesSummary([], NOW, false).note).toMatch(/No dates yet/);
  });
  it('a mix says how many can move', () => {
    const v = datesSummary(
      [
        { status: 'SCHEDULED', startsAt: iso(5), endsAt: iso(7), sold: 0, held: 0 },
        { status: 'SCHEDULED', startsAt: iso(5), endsAt: iso(7), sold: 4, held: 0 },
      ],
      NOW,
      false,
    );
    expect(v.note).toMatch(/^2 dates\. 1 can still move/);
  });
});

describe('copy', () => {
  it('is ASCII only', () => {
    const notes = [
      ...['DRAFT', 'UNDER_REVIEW', 'PUBLISHED', 'PAUSED', 'SOLD_OUT', 'CANCELLED', 'COMPLETED'].map(
        (status) => eventDetailsEditability({ status, canEdit: true }).note,
      ),
      sessionTimeEditability(
        { status: 'SCHEDULED', startsAt: iso(5), endsAt: iso(6), sold: 2, held: 0 },
        NOW,
        false,
      ).note,
      ticketPriceEditability({ isFree: false, sold: 0, held: 1 }).note,
      editLabel('review'),
    ];
    for (const n of notes) expect(n).toMatch(ASCII);
  });
});
