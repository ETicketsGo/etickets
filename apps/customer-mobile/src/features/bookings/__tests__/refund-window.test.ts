import { refundStatusLabel, refundWindow } from '../refunds';

jest.mock('@/services/api-client', () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));

const startsAt = '2026-11-15T05:00:00.000Z';
const start = new Date(startsAt).getTime();
const HOUR = 3_600_000;

describe('refundWindow', () => {
  const paid = { status: 'CONFIRMED', startsAt, refundsEnabled: true, refundCutoffHours: 48 };

  it('is open until the cutoff before the start', () => {
    const w = refundWindow(paid, start - 49 * HOUR);
    expect(w.kind).toBe('open');
    if (w.kind === 'open') expect(w.closesAt.getTime()).toBe(start - 48 * HOUR);
  });

  it('is closed inside the cutoff', () => {
    expect(refundWindow(paid, start - 47 * HOUR).kind).toBe('closed');
  });

  it('is not offered when the event does not allow refunds', () => {
    expect(refundWindow({ ...paid, refundsEnabled: false }, start - 100 * HOUR).kind).toBe(
      'not-offered',
    );
  });

  it.each(['PENDING_PAYMENT', 'CANCELLED', 'EXPIRED', 'REFUNDED'])(
    'does not apply to a %s booking',
    (status) => {
      expect(refundWindow({ ...paid, status }, start - 100 * HOUR).kind).toBe('not-applicable');
    },
  );

  it('treats a missing cutoff as "until the start"', () => {
    expect(refundWindow({ ...paid, refundCutoffHours: null }, start - HOUR).kind).toBe('open');
  });
});

describe('refundStatusLabel', () => {
  it('words every status the API sends', () => {
    for (const s of ['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED']) {
      expect(refundStatusLabel(s).label).not.toBe(s);
    }
  });
});
