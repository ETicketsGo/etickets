import { describe, expect, it } from 'vitest';
import { previewLines, totalsText } from './cancel-impact';

const empty = {
  datesToCancel: 1,
  onlineRefunds: { count: 0, totals: [] },
  alreadyInRefund: 0,
  free: 0,
  cash: { count: 0, totals: [] },
};

describe('what cancelling an event does, before confirming', () => {
  it('names the online refunds and the cash separately, each with its total', () => {
    const lines = previewLines({
      ...empty,
      onlineRefunds: { count: 1, totals: [{ currency: 'INR', amountMinor: 21420 }] },
      cash: { count: 2, totals: [{ currency: 'INR', amountMinor: 42840 }] },
    });
    const online = lines.find((l) => l.includes('online booking'));
    const cash = lines.find((l) => l.includes('cash at the counter'));
    expect(online).toContain('1 online booking gets a refund request');
    expect(online).toContain('214.20');
    expect(cash).toContain('2 bookings were paid in cash');
    expect(cash).toContain('428.40');
    expect(cash).toContain('Their tickets stop working now');
  });

  it('never adds two currencies into one figure', () => {
    expect(
      totalsText([
        { currency: 'INR', amountMinor: 10000 },
        { currency: 'USD', amountMinor: 2000 },
      ]),
    ).toMatch(/100(\.00)? and \$20\.00/);
  });

  it('says plainly when nobody has booked', () => {
    expect(previewLines(empty)).toContain(
      'Nobody has booked a date still to come, so there is nothing to refund.',
    );
  });

  it('is ASCII apart from currency symbols', () => {
    const lines = previewLines({
      datesToCancel: 2,
      onlineRefunds: { count: 3, totals: [{ currency: 'USD', amountMinor: 100 }] },
      alreadyInRefund: 1,
      free: 2,
      cash: { count: 1, totals: [{ currency: 'USD', amountMinor: 100 }] },
    });
    for (const l of lines) expect(l).toMatch(/^[\x20-\x7E]*$/);
  });
});
