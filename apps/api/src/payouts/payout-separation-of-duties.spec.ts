import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ADMIN_PERMISSION_KEY } from '../common/decorators';
import { AdminPermission } from '@eticketsgo/shared-types';
import { AdminPayoutsController } from './payouts.controller';
import { SettlementController } from '../payments/settlement/settlement.controller';
import { verifierMayNotPay } from './payout-account-safety';

describe('verifierMayNotPay', () => {
  it('refuses the person who verified, and nobody else', () => {
    expect(verifierMayNotPay({ actorUserId: 'a', verifiedByUserId: 'a' })).toBe(true);
    expect(verifierMayNotPay({ actorUserId: 'b', verifiedByUserId: 'a' })).toBe(false);
  });
  it('has nothing to refuse when nobody verified (the destination hold handles that)', () => {
    expect(verifierMayNotPay({ actorUserId: 'a', verifiedByUserId: null })).toBe(false);
    expect(verifierMayNotPay({ actorUserId: 'a', verifiedByUserId: undefined })).toBe(false);
  });
});

/** Walk src for non-spec TypeScript files. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith('.ts') && !/\.(spec|d)\.ts$/.test(name)) out.push(full);
  }
  return out;
}

describe('every way a payout becomes PAID', () => {
  it('goes through markPaid: no other code writes status PAID on a payout', () => {
    // A scheduled run, a provider execution or a retry job that set PAID directly would bypass
    // the verifier rule. If this fails, route the new path through markPaid (or apply
    // `verifierMayNotPay` to it) before changing this list.
    const root = join(__dirname, '..');
    const writers = sourceFiles(root)
      .filter((f) => /PayoutStatus\.PAID|status:\s*['"]PAID['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).split(sep).join('/'))
      .filter((f) => {
        const text = readFileSync(join(root, f), 'utf8');
        // A write sets it in `data:`; reads compare it in `where`/`===`.
        return /data:\s*\{[^}]*status:\s*PayoutStatus\.PAID/s.test(text);
      });
    expect(writers).toEqual(['payouts/payouts.service.ts']);
  });

  it('is applied inside markPaid, after the destination hold, in the same transaction', () => {
    const text = readFileSync(join(__dirname, 'payouts.service.ts'), 'utf8');
    const mark = text.indexOf('async markPaid(');
    const guard = text.indexOf('verifierMayNotPay({', mark);
    const claim = text.indexOf('this.claimPaid(tx', mark);
    expect(guard).toBeGreaterThan(mark);
    expect(claim).toBeGreaterThan(guard);
  });
});

describe('the capability each money action needs', () => {
  const needs = (cls: object, handler: string) =>
    Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      (cls as { prototype: object }).prototype[handler as never],
    ) as AdminPermission[] | undefined;

  it.each([
    [AdminPayoutsController, 'pay', AdminPermission.PAYOUT_EXECUTE],
    [AdminPayoutsController, 'fail', AdminPermission.PAYOUT_EXECUTE],
    [AdminPayoutsController, 'verifyAccount', AdminPermission.BANK_VERIFY],
    [AdminPayoutsController, 'rejectAccount', AdminPermission.BANK_VERIFY],
    [SettlementController, 'approve', AdminPermission.PAYOUT_EXECUTE],
    [SettlementController, 'release', AdminPermission.PAYOUT_EXECUTE],
  ])('%p.%s needs PAYOUT_MANAGE and its own duty', (cls, handler, duty) => {
    expect(needs(cls, handler)).toEqual([AdminPermission.PAYOUT_MANAGE, duty]);
  });

  it('never lets one duty stand in for the other', () => {
    expect(needs(AdminPayoutsController, 'pay')).not.toContain(AdminPermission.BANK_VERIFY);
    expect(needs(AdminPayoutsController, 'verifyAccount')).not.toContain(
      AdminPermission.PAYOUT_EXECUTE,
    );
  });
});
