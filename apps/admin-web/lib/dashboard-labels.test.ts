import { describe, expect, it } from 'vitest';
import { failedPaymentsQueue } from './attention';
import {
  bookingsLabel,
  failedPaymentsAllTimeLabel,
  FAILED_PAYMENTS_WEEK_SCOPE,
} from './dashboard-labels';

describe('platform overview labels', () => {
  const week = failedPaymentsQueue(new Date('2026-10-12T10:00:00Z')).label(39);

  it('the weekly failed-payments line names its window and that it spans every market', () => {
    expect(week).toContain('last 7 days');
    expect(week).toContain(FAILED_PAYMENTS_WEEK_SCOPE);
  });

  it('the per-market failed-payments tile names its currency and that it is all time', () => {
    const tile = failedPaymentsAllTimeLabel('INR');
    expect(tile).toContain('INR');
    expect(tile).toContain('all time');
    expect(tile).not.toContain('7 days');
  });

  it('the two failure counts can never carry the same words', () => {
    expect(week).not.toBe(failedPaymentsAllTimeLabel('INR'));
  });

  it('a bookings count names its market', () => {
    expect(bookingsLabel('USD')).toBe('Bookings in USD');
    expect(bookingsLabel(undefined)).toContain('all markets');
  });
});
