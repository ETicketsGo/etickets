import { describe, expect, it } from 'vitest';
import {
  addFormState,
  firstInvalidField,
  initialSessionId,
  pluralOf,
  priceLabel,
  resolveSessionId,
  ticketWords,
  validateTicketType,
  validateTicketTypeEdit,
  withArticle,
  type TicketTypeFields,
} from './ticket-type-form';

const one = [{ id: 's1' }];
const three = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];

describe('ticketWords: the wizard words for the event', () => {
  it('names a session the way the create wizard does', () => {
    expect(ticketWords('Music')).toEqual({ session: 'Performance', ticket: 'Ticket type' });
    expect(ticketWords('Sports')).toEqual({ session: 'Match', ticket: 'Ticket type' });
    expect(ticketWords('Theatre')).toEqual({ session: 'Show', ticket: 'Ticket type' });
    expect(ticketWords('Exhibition').session).toBe('Opening');
  });

  it('sells passes, by the day, at a conference', () => {
    expect(ticketWords('Conference')).toEqual({ session: 'Day', ticket: 'Pass' });
  });

  it('falls back to the plain words for a typed or missing category', () => {
    expect(ticketWords('Pottery club')).toEqual({ session: 'Session', ticket: 'Ticket type' });
    expect(ticketWords(undefined)).toEqual({ session: 'Session', ticket: 'Ticket type' });
  });
});

describe('labels', () => {
  it('names the currency code and the symbol, like the wizard', () => {
    expect(priceLabel('INR', '₹')).toBe('Price (INR, ₹)');
    expect(priceLabel('USD', '$')).toBe('Price (USD, $)');
    // No symbol of its own: the code once, not "CHF, CHF".
    expect(priceLabel('CHF', 'CHF')).toBe('Price (CHF)');
  });

  it('uses the right article and plural', () => {
    expect(withArticle('Match')).toBe('a match');
    expect(withArticle('Opening')).toBe('an opening');
    expect(pluralOf('Ticket type')).toBe('ticket types');
    expect(pluralOf('Pass')).toBe('passes');
  });
});

describe('which session the form starts on', () => {
  it('chooses the only session, so a one-night event never asks', () => {
    expect(initialSessionId(one)).toBe('s1');
    expect(resolveSessionId(one, '')).toBe('s1');
  });

  it('guesses nothing when there are several', () => {
    expect(initialSessionId(three)).toBe('');
    expect(resolveSessionId(three, '')).toBe('');
    expect(resolveSessionId(three, 's2')).toBe('s2');
  });

  it('drops a pick that is no longer one of the sessions', () => {
    expect(resolveSessionId(three, 'gone')).toBe('');
    expect(resolveSessionId(one, 'gone')).toBe('s1');
  });
});

describe('addFormState: never a dead button without a reason', () => {
  const words = ticketWords('Sports');

  it('is ready at once with one session', () => {
    expect(addFormState(one, '', words)).toEqual({ kind: 'ready' });
  });

  it('says to select a match first when there are several and none is picked', () => {
    const state = addFormState(three, '', words);
    expect(state.kind).toBe('choose');
    expect(state.kind === 'choose' && state.message).toBe(
      'Select a match first. Each ticket type is sold for one match, and this event has 3.',
    );
    expect(addFormState(three, 's3', words)).toEqual({ kind: 'ready' });
  });

  it('points at adding a session when there is none', () => {
    const state = addFormState([], '', ticketWords('Conference'));
    expect(state.kind).toBe('no-sessions');
    expect(state.kind === 'no-sessions' && state.message).toBe(
      'Each pass is sold for one day. Add one on the Sessions page, then come back here.',
    );
  });
});

describe('validateTicketType: the wizard rules and words', () => {
  const words = ticketWords('Music');
  const ok: TicketTypeFields = {
    eventSessionId: 's1',
    name: 'VIP',
    priceMajor: '499',
    quantityTotal: '100',
    maxPerOrder: '6',
  };
  const opts = { words, isFree: false, existingNames: ['General'], sessionIds: ['s1', 's2'] };

  it('accepts a complete ticket type', () => {
    expect(validateTicketType(ok, opts)).toEqual({});
  });

  it('asks for the session in the event word, and focuses it first', () => {
    const e = validateTicketType({ ...ok, eventSessionId: '', name: '' }, opts);
    expect(e.eventSessionId).toBe('Select a performance.');
    expect(e.name).toBe('Name is required.');
    expect(firstInvalidField(e)).toBe('eventSessionId');
  });

  it('refuses a second ticket type with the same name on the same session', () => {
    expect(validateTicketType({ ...ok, name: ' general ' }, opts).name).toBe(
      'Another ticket type for this performance has the same name.',
    );
  });

  it('checks the price, but not on a free event', () => {
    expect(validateTicketType({ ...ok, priceMajor: '' }, opts).priceMajor).toBe(
      'Enter a valid price (0 or more).',
    );
    expect(validateTicketType({ ...ok, priceMajor: '-1' }, opts).priceMajor).toBeDefined();
    expect(validateTicketType({ ...ok, priceMajor: '0' }, opts).priceMajor).toBeUndefined();
    expect(
      validateTicketType({ ...ok, priceMajor: '' }, { ...opts, isFree: true }).priceMajor,
    ).toBeUndefined();
  });

  it('wants whole tickets, at least one', () => {
    for (const q of ['', '0', '1.5', 'abc']) {
      expect(validateTicketType({ ...ok, quantityTotal: q }, opts).quantityTotal).toBe(
        'Quantity must be a whole number, at least 1.',
      );
    }
  });

  it('keeps max per order between 1, the quantity and the API limit; blank is the default', () => {
    expect(validateTicketType({ ...ok, maxPerOrder: '' }, opts)).toEqual({});
    expect(validateTicketType({ ...ok, maxPerOrder: '0' }, opts).maxPerOrder).toBe(
      'Max per order must be a whole number, at least 1.',
    );
    expect(validateTicketType({ ...ok, maxPerOrder: '51' }, opts).maxPerOrder).toBe(
      'Max per order can be at most 50.',
    );
    expect(
      validateTicketType({ ...ok, quantityTotal: '4', maxPerOrder: '6' }, opts).maxPerOrder,
    ).toBe('Max per order cannot be more than the quantity on sale.');
  });
});

describe('validateTicketTypeEdit', () => {
  const ok = { name: 'VIP', priceMajor: '499', quantityTotal: '100', maxPerOrder: '6' };
  const opts = { isFree: false, priceLocked: false, committed: 0 };

  it('accepts an unchanged ticket type', () => {
    expect(validateTicketTypeEdit(ok, opts)).toEqual({});
  });

  it('says the quantity cannot drop below what is sold or held', () => {
    expect(
      validateTicketTypeEdit({ ...ok, quantityTotal: '5' }, { ...opts, committed: 8 })
        .quantityTotal,
    ).toBe('Quantity cannot be less than the 8 already sold or held.');
  });

  it('does not judge a locked or free price', () => {
    expect(
      validateTicketTypeEdit({ ...ok, priceMajor: '' }, { ...opts, priceLocked: true }),
    ).toEqual({});
    expect(validateTicketTypeEdit({ ...ok, priceMajor: '' }, { ...opts, isFree: true })).toEqual(
      {},
    );
  });
});
