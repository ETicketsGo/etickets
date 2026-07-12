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
  it('defaults currency to INR and maxPerOrder to 10', () => {
    const parsed = createTicketTypeSchema.parse({
      eventSessionId: 'clzzzzzzzzzzzzzzzzzzzzzzzz',
      name: 'General',
      priceMinor: 49900,
      quantityTotal: 100,
    });
    expect(parsed.currency).toBe('INR');
    expect(parsed.maxPerOrder).toBe(10);
  });
});
