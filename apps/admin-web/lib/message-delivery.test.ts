import { describe, expect, it } from 'vitest';
import { channelName, messageName, orderMessages, verdictPill } from './message-delivery';

describe('verdictPill', () => {
  it('never says sent for a message that went nowhere', () => {
    expect(verdictPill('LOG_ONLY')).toEqual({ word: 'Not sent (log only)', tone: 'warning' });
    expect(verdictPill('NOT_SENT')).toEqual({ word: 'Not sent', tone: 'warning' });
    expect(verdictPill('NOT_DELIVERED').tone).toBe('error');
  });

  it('only calls it delivered when it was', () => {
    expect(verdictPill('DELIVERED').word).toBe('Delivered');
    expect(verdictPill('ACCEPTED').word).toBe('Sent, not confirmed');
  });
});

describe('names', () => {
  it('reads channels and message types in words', () => {
    expect(channelName('whatsapp')).toBe('WhatsApp');
    expect(messageName('BOOKING_CONFIRMED')).toBe('Booking confirmed');
    expect(messageName('ORGANIZATION_APPROVED')).toBe('Organization approved');
  });
});

describe('orderMessages', () => {
  it('puts the newest first and hides nothing', () => {
    const row = (id: string, createdAt: string) =>
      ({ id, createdAt }) as Parameters<typeof orderMessages>[0][number];
    expect(
      orderMessages([row('a', '2026-10-01T00:00:00Z'), row('b', '2026-10-02T00:00:00Z')]).map(
        (r) => r.id,
      ),
    ).toEqual(['b', 'a']);
  });
});
