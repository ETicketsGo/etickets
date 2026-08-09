import { describe, expect, it } from 'vitest';
import type { LiveSeat } from '@eticketsgo/web-kit';
import {
  describeExpiry,
  explainOverrideCode,
  formatLocalTime,
  formatMoney,
  freshness,
  isLive,
  occupancyLabel,
  occupancyTone,
  OVERRIDE_KINDS,
  OVERRIDE_LABEL,
  OVERRIDE_TONE,
  seatAccessibleName,
  seatActions,
  seatTone,
} from './seat-presentation';

const IST = 'Asia/Kolkata';
const NOW = new Date('2026-08-08T12:00:00Z');

const seat = (over: Partial<LiveSeat> = {}): LiveSeat => ({
  seatId: 's1',
  label: 'A1',
  row: 'A',
  colIndex: 1,
  kind: 'SEAT',
  categoryId: 'c1',
  status: 'AVAILABLE',
  overrideKind: null,
  overrideReason: null,
  overrideBy: null,
  overrideAt: null,
  overrideExpiresAt: null,
  heldNow: false,
  ...over,
});

describe('seatTone', () => {
  it('draws an aisle gap as a gap, not an empty seat', () => {
    // Otherwise an operator tries to block the aisle and gets a refusal they cannot explain.
    expect(seatTone(seat({ kind: 'GAP' }))).toBe('gap');
  });

  it('maps the plain states', () => {
    expect(seatTone(seat())).toBe('available');
    expect(seatTone(seat({ status: 'SOLD' }))).toBe('sold');
    expect(seatTone(seat({ status: 'BLOCKED', overrideKind: 'HOUSE' }))).toBe('blocked');
  });

  it('shows a LIVE hold as held', () => {
    expect(seatTone(seat({ status: 'HELD', heldNow: true }))).toBe('held');
  });

  it('shows an EXPIRED hold as available', () => {
    // The row still says HELD until the sweeper runs. Drawing it as busy tells the operator
    // a seat is taken when it is actually free.
    expect(seatTone(seat({ status: 'HELD', heldNow: false }))).toBe('available');
  });
});

describe('seatActions', () => {
  it('offers block on a free seat', () => {
    expect(seatActions(seat())).toEqual({ block: true, release: false });
  });

  it('offers release only on a blocked seat', () => {
    expect(seatActions(seat({ status: 'BLOCKED', overrideKind: 'MANUAL_BLOCK' }))).toEqual({
      block: true,
      release: true,
    });
  });

  it('offers NOTHING on a sold seat', () => {
    // The single most important affordance rule: somebody holds a ticket.
    expect(seatActions(seat({ status: 'SOLD' }))).toEqual({ block: false, release: false });
  });

  it('offers nothing while a customer is mid-checkout', () => {
    expect(seatActions(seat({ status: 'HELD', heldNow: true }))).toEqual({
      block: false,
      release: false,
    });
  });

  it('offers block again once the hold has lapsed', () => {
    expect(seatActions(seat({ status: 'HELD', heldNow: false })).block).toBe(true);
  });

  it('offers nothing on an aisle gap', () => {
    expect(seatActions(seat({ kind: 'GAP' }))).toEqual({ block: false, release: false });
  });
});

describe('seatAccessibleName', () => {
  it('names an available seat', () => {
    expect(seatAccessibleName(seat())).toBe('Seat A1, available');
  });

  it('announces a wheelchair space as such', () => {
    // Accessibility information must not be conveyed by an icon alone.
    expect(seatAccessibleName(seat({ kind: 'WHEELCHAIR' }))).toContain('wheelchair space');
  });

  it('announces a companion seat', () => {
    expect(seatAccessibleName(seat({ kind: 'COMPANION' }))).toContain('companion seat');
  });

  it('carries the override kind AND its reason', () => {
    const name = seatAccessibleName(
      seat({ status: 'BLOCKED', overrideKind: 'MAINTENANCE', overrideReason: 'broken recliner' }),
    );
    expect(name).toContain('maintenance');
    expect(name).toContain('broken recliner');
  });

  it('says sold plainly', () => {
    expect(seatAccessibleName(seat({ status: 'SOLD' }))).toContain('sold');
  });

  it('does not announce a lapsed hold as held', () => {
    expect(seatAccessibleName(seat({ status: 'HELD', heldNow: false }))).toContain('available');
  });

  it('describes an aisle rather than calling it a seat', () => {
    expect(seatAccessibleName(seat({ kind: 'GAP' }))).toMatch(/aisle/i);
  });
});

describe('explainOverrideCode', () => {
  it('translates every refusal the API can return', () => {
    expect(explainOverrideCode('SEAT_SOLD')).toMatch(/already been sold/i);
    expect(explainOverrideCode('SEAT_HELD')).toMatch(/held by a customer/i);
    expect(explainOverrideCode('SEAT_TAKEN_CONCURRENTLY')).toMatch(/changed while you were/i);
    expect(explainOverrideCode('SEAT_NOT_BLOCKED')).toMatch(/no longer blocked/i);
    expect(explainOverrideCode('EMERGENCY_REQUIRES_FORCE')).toMatch(/emergency/i);
    expect(explainOverrideCode('SEAT_NOT_ON_SHOW')).toMatch(/do not belong/i);
  });

  it('falls back to the server message for a code it does not know', () => {
    // A newer API adding a code must not produce a blank dialog.
    expect(explainOverrideCode('SOMETHING_NEW', 'Server said no.')).toBe('Server said no.');
  });

  it('has a last-resort sentence when there is no message either', () => {
    expect(explainOverrideCode(undefined)).toBeTruthy();
  });
});

describe('vocabulary', () => {
  it('every override kind has a label and a tone', () => {
    for (const kind of OVERRIDE_KINDS) {
      expect(OVERRIDE_LABEL[kind]).toBeTruthy();
      expect(OVERRIDE_TONE[kind]).toBeTruthy();
    }
  });

  it('emergency reads as the most severe', () => {
    expect(OVERRIDE_TONE.EMERGENCY).toBe('error');
  });

  it('house and maintenance are visually distinct', () => {
    // An operator scanning a map must be able to tell a comp from a fault.
    expect(OVERRIDE_TONE.HOUSE).not.toBe(OVERRIDE_TONE.MAINTENANCE);
    expect(OVERRIDE_LABEL.HOUSE).not.toBe(OVERRIDE_LABEL.MAINTENANCE);
  });
});

describe('occupancy presentation', () => {
  it('renders null as a dash, not zero percent', () => {
    // Nothing sellable is not the same as nothing sold.
    expect(occupancyLabel(null)).toBe('—');
    expect(occupancyLabel(0)).toBe('0%');
  });

  it('does not treat a quiet show as an error', () => {
    expect(occupancyTone(12)).toBe('neutral');
    expect(occupancyTone(null)).toBe('neutral');
  });

  it('calls out a near-full house', () => {
    expect(occupancyTone(96)).toBe('success');
  });
});

describe('formatting', () => {
  it('renders integer minor units as money', () => {
    expect(formatMoney(250000, 'INR')).toContain('2,500');
  });

  it('renders cinema-local 24-hour time, not the browser zone', () => {
    expect(formatLocalTime('2026-11-17T19:00:00Z', IST)).toBe('00:30');
  });

  it('describes snapshot freshness', () => {
    expect(freshness('2026-08-08T11:59:55Z', NOW)).toBe('just now');
    expect(freshness('2026-08-08T11:59:00Z', NOW)).toBe('60s ago');
    expect(freshness('2026-08-08T11:50:00Z', NOW)).toBe('10 min ago');
  });
});

describe('isLive', () => {
  const snap = (startsAt: string, endsAt: string) => ({ startsAt, endsAt }) as never;

  it('is true during the show', () => {
    expect(isLive(snap('2026-08-08T11:00:00Z', '2026-08-08T13:00:00Z'), NOW)).toBe(true);
  });
  it('is false before and after', () => {
    expect(isLive(snap('2026-08-08T13:00:00Z', '2026-08-08T15:00:00Z'), NOW)).toBe(false);
    expect(isLive(snap('2026-08-08T09:00:00Z', '2026-08-08T11:00:00Z'), NOW)).toBe(false);
  });
});

describe('describeExpiry', () => {
  it('says nothing when there is no expiry', () => {
    expect(describeExpiry(null, NOW, IST)).toBeNull();
  });

  it('names the local time a seat returns to sale', () => {
    expect(describeExpiry('2026-08-08T13:30:00Z', NOW, IST)).toContain('19:00');
  });

  it('explains a lapsed expiry rather than showing a past time as if it were future', () => {
    // The sweeper runs on a cadence, so a short window where it has passed is normal — but
    // the operator has to be told that, not left wondering why the seat is still blocked.
    expect(describeExpiry('2026-08-08T11:00:00Z', NOW, IST)).toMatch(/passed/i);
  });
});
