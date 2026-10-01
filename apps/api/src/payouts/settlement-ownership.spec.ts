import { SETTLEMENT_CLAIMED_STATUSES } from './payouts.service';

/**
 * The boundary that stops the same revenue being paid twice.
 *
 * ── WHAT THIS GUARDS ───────────────────────────────────────────────────────────────
 * An organizer can be paid two ways: the platform ledger (`Payout`), settled by a bank transfer
 * somebody makes by hand, and `Settlement`, which moves money through Stripe or Razorpay Route.
 * Once a provider transfer has claimed an event's money, that event must leave the platform
 * ledger entirely, or the second payment looks exactly like the first.
 *
 * `REVERSED` was absent from this set, so reaching it released the whole event back into the
 * platform path. A partial refund can reach it - which made an ordinary refund a route to paying
 * the same revenue twice.
 *
 * These are unit tests over the SET. The real-Postgres tests in
 * `payout-summary.integration-postgres.spec.ts` prove the same rule end to end, against a real
 * payout calculation. Both are needed: this one says what the rule IS, that one says the rule is
 * actually applied.
 */

/** Every value of `SettlementStatus` in schema.prisma, listed so a new one cannot slip past. */
const ALL_SETTLEMENT_STATUSES = [
  'PENDING',
  'HELD',
  'ELIGIBLE',
  'APPROVED',
  'TRANSFER_PROCESSING',
  'TRANSFERRED',
  'PARTIALLY_REFUNDED',
  'BLOCKED',
  'FAILED',
  'REVERSED',
] as const;

/**
 * The statuses that mean a provider has, or is about to have, moved the money.
 *
 * Deliberately spelled out again rather than derived from the constant under test: a test that
 * computes its expectation the same way the code does proves only that the code agrees with
 * itself.
 */
const MONEY_IS_WITH_THE_PROVIDER = [
  'TRANSFER_PROCESSING',
  'TRANSFERRED',
  'PARTIALLY_REFUNDED',
  'REVERSED',
] as const;

describe('which settlement statuses claim an event from the platform ledger', () => {
  it.each(MONEY_IS_WITH_THE_PROVIDER)('%s is provider-claimed', (status) => {
    expect(SETTLEMENT_CLAIMED_STATUSES).toContain(status);
  });

  it('claims REVERSED, so a reversed transfer never releases the event on its own', () => {
    /*
      The specific regression. `REVERSED` says money came back; it does NOT say why. An
      administrative correction leaves the organizer unpaid, a customer refund means the revenue
      is gone. The status cannot tell those apart, so the conservative default holds the event.
    */
    expect(SETTLEMENT_CLAIMED_STATUSES).toContain('REVERSED');
  });

  it('claims nothing that happens before money moves', () => {
    // Claiming these would strand revenue in neither path - owed by nobody.
    for (const status of ['PENDING', 'HELD', 'ELIGIBLE', 'APPROVED', 'BLOCKED', 'FAILED']) {
      expect(SETTLEMENT_CLAIMED_STATUSES).not.toContain(status);
    }
  });

  it('covers every settlement status exactly once, either claimed or not', () => {
    const claimed = SETTLEMENT_CLAIMED_STATUSES;
    const unknown = claimed.filter(
      (s) => !(ALL_SETTLEMENT_STATUSES as readonly string[]).includes(s),
    );
    expect(unknown).toEqual([]);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('is the exact set, so widening or narrowing it is a deliberate act', () => {
    /*
      A snapshot of the boundary. Anyone changing who owns revenue has to change this line and
      say why, rather than editing a filter somewhere and moving money by accident.
    */
    expect([...SETTLEMENT_CLAIMED_STATUSES].sort()).toEqual([
      'PARTIALLY_REFUNDED',
      'REVERSED',
      'TRANSFERRED',
      'TRANSFER_PROCESSING',
    ]);
  });
});

describe('the reversal cases that used to release an event', () => {
  it('a PARTIAL reversal leaves the event provider-claimed', () => {
    // A partial reversal sets PARTIALLY_REFUNDED, which was already claimed. Unchanged, asserted
    // so it cannot regress alongside the REVERSED fix.
    expect(SETTLEMENT_CLAIMED_STATUSES).toContain('PARTIALLY_REFUNDED');
  });

  it('a FULL reversal leaves the event provider-claimed', () => {
    // This is the one that changed. Before, a full reversal released the event with nothing
    // recorded about why the money came back.
    expect(SETTLEMENT_CLAIMED_STATUSES).toContain('REVERSED');
  });

  it('no settlement status releases an event by itself', () => {
    /*
      The invariant stated positively: every status in which a provider holds or held the money
      is claimed. Release will require an explicit recorded disposition, which does not exist
      yet - so today there is no path out at all, which is the safe end to be at.
    */
    const releasedWhileProviderHasMoney = MONEY_IS_WITH_THE_PROVIDER.filter(
      (s) => !SETTLEMENT_CLAIMED_STATUSES.includes(s),
    );
    expect(releasedWhileProviderHasMoney).toEqual([]);
  });
});
