import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Resolved engineering question (owner decisions 2026-10-27): a platform fee policy's order
 * slot is NOT given back when a paid booking is refunded or cancelled. Only an UNPAID hold that
 * is released gives one back; otherwise a limited waiver could be cycled by buying and
 * refunding (see fee-policy-redemption.ts).
 *
 * Held as the code's shape: exactly one place gives a slot back, and that place acts only on a
 * booking it has just claimed from PENDING_PAYMENT. The refund and cancellation services never
 * reach it.
 */
const SRC = join(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('resolved: a refund does not give a fee policy order slot back', () => {
  const callers = sourceFiles(SRC)
    .filter((f) => /releaseFeePolicyRedemption\(/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f).replace(/\\/g, '/'))
    .sort();

  it('only the unpaid-hold release gives a slot back', () => {
    expect(callers).toEqual([
      'inventory/expire-pending-booking.ts',
      'pricing/fee-policy-redemption.ts',
    ]);
  });

  it('and that release claims only a booking still awaiting payment', () => {
    const text = readFileSync(join(SRC, 'inventory/expire-pending-booking.ts'), 'utf8');
    const claim = text.indexOf('status: BookingStatus.PENDING_PAYMENT');
    const release = text.indexOf('releaseFeePolicyRedemption(tx');
    expect(claim).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(claim);
    // The release runs only after a claim that moved exactly one row.
    expect(text.slice(claim, release)).toMatch(/if \(claimed\.count !== 1\) return false;/);
  });

  it('no refund or cancellation code mentions the release', () => {
    expect(callers.some((f) => /refund|cancel/i.test(f))).toBe(false);
  });
});
