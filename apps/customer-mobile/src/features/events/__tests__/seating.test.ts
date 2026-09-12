import { eventDetailSchema, type EventDetail } from '../schema';
import {
  SEAT_SELECTION_ON_WEBSITE,
  SeatSelectionUnavailableError,
  findSessionInEvents,
  isQuantityOnlyForSeatedSession,
  requiresSeatSelection,
} from '../seating';

function makeEvent(sessions: Record<string, unknown>[]): EventDetail {
  return eventDetailSchema.parse({
    id: 'evt_1',
    title: 'Hamlet',
    slug: 'hamlet',
    experienceType: 'EVENT',
    category: 'Theatre',
    description: null,
    refundPolicy: null,
    feeMode: 'CUSTOMER_PAYS',
    venue: { id: 'v1', name: 'Hall', city: 'Pune', country: 'IN', address: null },
    organizer: { id: 'o1', name: 'Org' },
    sessions: sessions.map((s) => ({
      startsAt: '2026-10-01T14:00:00.000Z',
      endsAt: '2026-10-01T17:00:00.000Z',
      status: 'SCHEDULED',
      ticketTypes: [],
      ...s,
    })),
  });
}

describe('session contract', () => {
  it('keeps seatBased from the API', () => {
    // REGRESSION: the schema did not declare it, so Zod stripped it and a seated theatre
    // show was indistinguishable from general admission.
    const event = makeEvent([{ id: 's_seated', seatBased: true }]);
    expect(event.sessions[0].seatBased).toBe(true);
  });

  it('still parses an older API that does not send it', () => {
    expect(() => makeEvent([{ id: 's_old' }])).not.toThrow();
  });
});

describe('requiresSeatSelection', () => {
  it('follows the server when it says', () => {
    expect(requiresSeatSelection({ seatBased: true }, 'EVENT')).toBe(true);
    expect(requiresSeatSelection({ seatBased: false }, 'MOVIE')).toBe(false);
  });

  it('falls back to the experience type only when the server is silent', () => {
    expect(requiresSeatSelection({}, 'MOVIE')).toBe(true);
    expect(requiresSeatSelection(undefined, 'EVENT')).toBe(false);
  });
});

describe('isQuantityOnlyForSeatedSession', () => {
  it('blocks a quantity-only line for a seated session', () => {
    expect(isQuantityOnlyForSeatedSession({ seatBased: true }, [{ seatIds: undefined }])).toBe(
      true,
    );
    expect(isQuantityOnlyForSeatedSession({ seatBased: true }, [{ seatIds: [] }])).toBe(true);
  });

  it('lets seated lines that name their seats through', () => {
    expect(isQuantityOnlyForSeatedSession({ seatBased: true }, [{ seatIds: ['a1'] }])).toBe(false);
  });

  it('never blocks general admission, or a session whose seating is unknown', () => {
    expect(isQuantityOnlyForSeatedSession({ seatBased: false }, [{}])).toBe(false);
    expect(isQuantityOnlyForSeatedSession({}, [{}])).toBe(false);
    expect(isQuantityOnlyForSeatedSession(undefined, [{}])).toBe(false);
  });
});

describe('findSessionInEvents', () => {
  it('finds the session in whichever cached event holds it', () => {
    const events = [
      undefined,
      makeEvent([{ id: 's_a' }]),
      makeEvent([{ id: 's_b', seatBased: true }]),
    ];
    expect(findSessionInEvents(events, 's_b')?.seatBased).toBe(true);
    expect(findSessionInEvents(events, 'missing')).toBeUndefined();
  });
});

describe('SeatSelectionUnavailableError', () => {
  it('carries the message the buyer is shown', () => {
    expect(new SeatSelectionUnavailableError().message).toBe(SEAT_SELECTION_ON_WEBSITE);
  });
});
