import { describe, it, expect } from 'vitest';
import { registerSchema, loginSchema, createBookingSchema, createTicketTypeSchema } from './index';

describe('auth schemas', () => {
  it('accepts a valid registration and lowercases the email', () => {
    const parsed = registerSchema.parse({
      email: 'User@Example.com',
      password: 'Password123!',
      fullName: 'Jo',
    });
    expect(parsed.email).toBe('user@example.com');
  });

  it('rejects a short password', () => {
    expect(
      registerSchema.safeParse({ email: 'a@b.com', password: 'short', fullName: 'Jo' }).success,
    ).toBe(false);
  });

  it('login requires a non-empty password', () => {
    expect(loginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
  });
});

describe('booking schema', () => {
  const cuid = 'clzzzzzzzzzzzzzzzzzzzzzzzz';

  it('requires at least one item', () => {
    const r = createBookingSchema.safeParse({
      eventSessionId: cuid,
      items: [],
      buyerName: 'Riya Rao',
      buyerEmail: 'riya@example.com',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a well-formed booking', () => {
    const r = createBookingSchema.safeParse({
      eventSessionId: cuid,
      items: [{ ticketTypeId: cuid, quantity: 2 }],
      buyerName: 'Riya Rao',
      buyerEmail: 'riya@example.com',
    });
    expect(r.success).toBe(true);
  });
});

describe('ticket type schema', () => {
  const minimal = {
    eventSessionId: 'clzzzzzzzzzzzzzzzzzzzzzzzz',
    name: 'General',
    priceMinor: 49900,
    quantityTotal: 100,
  };

  /*
    This used to assert `currency === 'INR'`, and the default it was pinning was removed
    deliberately: a validation schema can see the request and cannot see the venue, so
    defaulting here priced every ticket type on the platform in rupees regardless of where
    the event was. The assertion is inverted rather than deleted -- leaving currency unset
    is now the contract, and something has to hold the door shut against a well-meaning
    `.default('INR')` coming back.
  */
  it('leaves currency UNSET, because only the venue knows it', () => {
    expect(createTicketTypeSchema.parse(minimal).currency).toBeUndefined();
  });

  it('still accepts a currency when the server supplies one', () => {
    expect(createTicketTypeSchema.parse({ ...minimal, currency: 'usd' }).currency).toBe('usd');
  });

  it('defaults maxPerOrder to 10', () => {
    expect(createTicketTypeSchema.parse(minimal).maxPerOrder).toBe(10);
  });
});
