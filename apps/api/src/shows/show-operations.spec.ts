import {
  FIELD_MUTABILITY,
  NO_COMMITMENTS,
  evaluateOperation,
  isBookable,
  publicShowState,
  type ShowCommitments,
  type ShowOperation,
  type ShowState,
} from './show-operations';

const NOW = new Date('2026-08-10T12:00:00Z');
const FUTURE = new Date('2026-08-20T18:00:00Z');
const PAST = new Date('2026-08-01T18:00:00Z');

const commitments = (over: Partial<ShowCommitments> = {}): ShowCommitments => ({
  ...NO_COMMITMENTS,
  ...over,
});

const check = (
  operation: ShowOperation,
  state: ShowState,
  over: Partial<ShowCommitments> = {},
  startsAt = FUTURE,
) => evaluateOperation({ operation, state, startsAt, commitments: commitments(over), now: NOW });

const allowed = (...args: Parameters<typeof check>) => check(...args).allowed;
const codeOf = (...args: Parameters<typeof check>) => {
  const v = check(...args);
  return v.allowed ? null : v.code;
};

/**
 * The policy matrix §6 asks for. Every cell is asserted rather than described, so the
 * matrix in the docs cannot drift away from what the code actually does.
 */
describe('operation policy matrix', () => {
  describe('PAUSE', () => {
    it('is allowed whatever is booked — it stops new sales and touches nothing existing', () => {
      expect(allowed('PAUSE', 'SCHEDULED')).toBe(true);
      expect(allowed('PAUSE', 'SCHEDULED', { activeHolds: 3 })).toBe(true);
      expect(allowed('PAUSE', 'SCHEDULED', { pendingPayment: 2 })).toBe(true);
      expect(allowed('PAUSE', 'SCHEDULED', { confirmed: 200 })).toBe(true);
    });

    it('is idempotent when already paused', () => {
      expect(check('PAUSE', 'PAUSED')).toEqual({ allowed: true, idempotent: true });
    });

    it('refuses a cancelled show', () => {
      expect(codeOf('PAUSE', 'CANCELLED')).toBe('SHOW_CANCELLED');
    });

    it('refuses a started show', () => {
      expect(codeOf('PAUSE', 'SCHEDULED', {}, PAST)).toBe('SHOW_ALREADY_STARTED');
    });

    it('refuses a completed show', () => {
      expect(codeOf('PAUSE', 'COMPLETED')).toBe('SHOW_ALREADY_COMPLETED');
    });
  });

  describe('REOPEN', () => {
    it('reopens a paused show', () => {
      expect(allowed('REOPEN', 'PAUSED')).toBe(true);
    });

    it('is idempotent when already on sale', () => {
      expect(check('REOPEN', 'SCHEDULED')).toEqual({ allowed: true, idempotent: true });
    });

    it('refuses a cancelled show — cancellation is not undone by reopening', () => {
      expect(codeOf('REOPEN', 'CANCELLED')).toBe('SHOW_CANCELLED');
    });

    it('refuses a show that has already started', () => {
      expect(codeOf('REOPEN', 'PAUSED', {}, PAST)).toBe('SHOW_ALREADY_STARTED');
    });

    it('reopens regardless of existing bookings', () => {
      expect(allowed('REOPEN', 'PAUSED', { confirmed: 50 })).toBe(true);
    });
  });

  describe('CANCEL', () => {
    it('is allowed in every live state and at every commitment level', () => {
      expect(allowed('CANCEL', 'SCHEDULED')).toBe(true);
      expect(allowed('CANCEL', 'PAUSED')).toBe(true);
      expect(allowed('CANCEL', 'SCHEDULED', { confirmed: 120 })).toBe(true);
      expect(allowed('CANCEL', 'SCHEDULED', { activeHolds: 4, pendingPayment: 1 })).toBe(true);
    });

    it('is idempotent when already cancelled', () => {
      expect(check('CANCEL', 'CANCELLED')).toEqual({ allowed: true, idempotent: true });
    });

    it('allows cancelling a show that has already started', () => {
      // A projector failing ten minutes in is exactly when cancellation is needed.
      expect(allowed('CANCEL', 'SCHEDULED', { confirmed: 80 }, PAST)).toBe(true);
    });

    it('refuses a finished show', () => {
      expect(codeOf('CANCEL', 'COMPLETED')).toBe('SHOW_ALREADY_COMPLETED');
    });
  });

  describe('EDIT_TIME', () => {
    it('is allowed with nothing booked', () => {
      expect(allowed('EDIT_TIME', 'SCHEDULED')).toBe(true);
      expect(allowed('EDIT_TIME', 'PAUSED')).toBe(true);
    });

    it('refuses when anyone has paid', () => {
      // Someone bought a seat at a stated time. Moving it silently is indefensible.
      expect(codeOf('EDIT_TIME', 'SCHEDULED', { confirmed: 1 })).toBe(
        'SHOW_HAS_CONFIRMED_BOOKINGS',
      );
    });

    it('refuses while someone is mid-checkout', () => {
      expect(codeOf('EDIT_TIME', 'SCHEDULED', { activeHolds: 1 })).toBe(
        'SHOW_HAS_ACTIVE_CHECKOUTS',
      );
      expect(codeOf('EDIT_TIME', 'SCHEDULED', { pendingPayment: 1 })).toBe(
        'SHOW_HAS_ACTIVE_CHECKOUTS',
      );
    });

    it('reports the confirmed booking first when both apply, as the harder blocker', () => {
      expect(codeOf('EDIT_TIME', 'SCHEDULED', { confirmed: 1, activeHolds: 1 })).toBe(
        'SHOW_HAS_CONFIRMED_BOOKINGS',
      );
    });

    it('refuses a started show', () => {
      expect(codeOf('EDIT_TIME', 'SCHEDULED', {}, PAST)).toBe('SHOW_ALREADY_STARTED');
    });
  });

  describe('EDIT_SCREEN', () => {
    it('is allowed only when nothing at all is committed', () => {
      expect(allowed('EDIT_SCREEN', 'SCHEDULED')).toBe(true);
    });

    it('is blocked by an unpaid hold, not just by a sale', () => {
      // Seats belong to a screen's layout. A held seat would silently cease to exist.
      expect(codeOf('EDIT_SCREEN', 'SCHEDULED', { activeHolds: 1 })).toBe('SHOW_HAS_BOOKINGS');
      expect(codeOf('EDIT_SCREEN', 'SCHEDULED', { pendingPayment: 1 })).toBe('SHOW_HAS_BOOKINGS');
      expect(codeOf('EDIT_SCREEN', 'SCHEDULED', { confirmed: 1 })).toBe('SHOW_HAS_BOOKINGS');
    });

    it('is stricter than EDIT_TIME, which tolerates nothing paid but is a different rule', () => {
      const holds = { activeHolds: 1 };
      expect(codeOf('EDIT_TIME', 'SCHEDULED', holds)).toBe('SHOW_HAS_ACTIVE_CHECKOUTS');
      expect(codeOf('EDIT_SCREEN', 'SCHEDULED', holds)).toBe('SHOW_HAS_BOOKINGS');
    });
  });

  it('never allows anything on a cancelled show except cancelling it again', () => {
    for (const op of ['PAUSE', 'REOPEN', 'EDIT_TIME', 'EDIT_SCREEN'] as ShowOperation[]) {
      expect(codeOf(op, 'CANCELLED')).toBe('SHOW_CANCELLED');
    }
    expect(check('CANCEL', 'CANCELLED').allowed).toBe(true);
  });

  it('always returns a verdict for every operation and state combination', () => {
    const ops: ShowOperation[] = ['PAUSE', 'REOPEN', 'CANCEL', 'EDIT_TIME', 'EDIT_SCREEN'];
    const states: ShowState[] = ['SCHEDULED', 'PAUSED', 'CANCELLED', 'COMPLETED'];
    for (const operation of ops) {
      for (const state of states) {
        const verdict = check(operation, state);
        expect(typeof verdict.allowed).toBe('boolean');
        if (!verdict.allowed) expect(verdict.code).toMatch(/^[A-Z_]+$/);
      }
    }
  });
});

describe('FIELD_MUTABILITY', () => {
  it('never lets a screen or movie change in place', () => {
    // Both invalidate every seat identifier or the product itself: cancel and recreate.
    expect(FIELD_MUTABILITY.screenId).toBe('D');
    expect(FIELD_MUTABILITY.movieId).toBe('D');
  });

  it('lets sales windows and prices move with bookings present', () => {
    // Neither can invalidate an existing purchase: bookings snapshot their totals.
    expect(FIELD_MUTABILITY.salesStartAt).toBe('B');
    expect(FIELD_MUTABILITY.salesEndAt).toBe('B');
    expect(FIELD_MUTABILITY.priceMinor).toBe('B');
  });

  it('treats the seat map as immutable after publication', () => {
    expect(FIELD_MUTABILITY.seatMapId).toBe('C');
  });
});

describe('publicShowState', () => {
  const base = {
    seatsRemaining: 100,
    limitedThreshold: 15,
    salesOpenAt: null,
    salesCloseAt: null,
    now: NOW,
  };

  it('reports availability bands from remaining seats', () => {
    expect(publicShowState({ ...base, state: 'SCHEDULED' })).toBe('AVAILABLE');
    expect(publicShowState({ ...base, state: 'SCHEDULED', seatsRemaining: 10 })).toBe('LIMITED');
    expect(publicShowState({ ...base, state: 'SCHEDULED', seatsRemaining: 0 })).toBe('SOLD_OUT');
  });

  it('treats exactly the threshold as limited', () => {
    expect(publicShowState({ ...base, state: 'SCHEDULED', seatsRemaining: 15 })).toBe('LIMITED');
    expect(publicShowState({ ...base, state: 'SCHEDULED', seatsRemaining: 16 })).toBe('AVAILABLE');
  });

  it('surfaces a paused show as paused rather than hiding it', () => {
    // A show that simply vanished looks like a bug to someone about to book it.
    expect(publicShowState({ ...base, state: 'PAUSED' })).toBe('SALES_PAUSED');
  });

  it('does not advertise remaining seats on a paused show', () => {
    expect(publicShowState({ ...base, state: 'PAUSED', seatsRemaining: 200 })).toBe('SALES_PAUSED');
  });

  it('reports cancellation ahead of everything else', () => {
    expect(publicShowState({ ...base, state: 'CANCELLED', seatsRemaining: 0 })).toBe('CANCELLED');
    expect(publicShowState({ ...base, state: 'CANCELLED', seatsRemaining: 200 })).toBe('CANCELLED');
  });

  it('describes a finished show as booking closed', () => {
    expect(publicShowState({ ...base, state: 'COMPLETED' })).toBe('BOOKING_CLOSED');
  });

  it('falls back to AVAILABLE when seat counts are unknown (general admission)', () => {
    expect(publicShowState({ ...base, state: 'SCHEDULED', seatsRemaining: null })).toBe(
      'AVAILABLE',
    );
  });

  describe('booking window boundaries', () => {
    const open = new Date('2026-08-10T10:00:00Z');
    const close = new Date('2026-08-10T14:00:00Z');
    const at = (iso: string) =>
      publicShowState({
        ...base,
        state: 'SCHEDULED',
        salesOpenAt: open,
        salesCloseAt: close,
        now: new Date(iso),
      });

    it('is closed one second before opening', () => {
      expect(at('2026-08-10T09:59:59Z')).toBe('BOOKING_CLOSED');
    });

    it('is open exactly at the opening instant', () => {
      expect(at('2026-08-10T10:00:00Z')).toBe('AVAILABLE');
    });

    it('is still open one second before closing', () => {
      expect(at('2026-08-10T13:59:59Z')).toBe('AVAILABLE');
    });

    it('is still open exactly at the closing instant, matching the server', () => {
      // Booking creation rejects on `salesEndAt < now`, so the close is INCLUSIVE. An
      // exclusive close here would read more naturally and would be wrong: for one
      // instant the listing would say closed on a show the server would still sell.
      expect(at('2026-08-10T14:00:00Z')).toBe('AVAILABLE');
    });

    it('is closed one millisecond after the closing instant', () => {
      expect(at('2026-08-10T14:00:00.001Z')).toBe('BOOKING_CLOSED');
    });

    it('is closed after closing', () => {
      expect(at('2026-08-10T14:00:01Z')).toBe('BOOKING_CLOSED');
    });

    it('lets a paused show read as paused even inside its window', () => {
      expect(
        publicShowState({
          ...base,
          state: 'PAUSED',
          salesOpenAt: open,
          salesCloseAt: close,
          now: new Date('2026-08-10T12:00:00Z'),
        }),
      ).toBe('SALES_PAUSED');
    });
  });
});

describe('isBookable', () => {
  it('is true only for states a customer can actually buy in', () => {
    expect(isBookable('AVAILABLE')).toBe(true);
    expect(isBookable('LIMITED')).toBe(true);
    for (const s of ['SOLD_OUT', 'SALES_PAUSED', 'BOOKING_CLOSED', 'CANCELLED'] as const) {
      expect(isBookable(s)).toBe(false);
    }
  });
});
