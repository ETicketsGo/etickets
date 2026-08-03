import { AdminService } from './admin.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';

/**
 * Guards on the fee-rule write path. These are money-configuration rules, and both failure
 * modes they prevent are silent: neither an inverted band nor an overlapping one throws at
 * booking time — they just charge the wrong fee, on some orders, depending on row order.
 */
describe('AdminService.updateFeeRule', () => {
  const RULE = {
    id: 'rule-1',
    label: '₹0–₹199',
    minMinor: 0,
    maxMinor: 19_900,
    feeMinor: 500,
    currency: 'INR',
    active: true,
  };

  function make(existing: unknown = RULE, siblings: unknown[] = []) {
    const update = jest.fn().mockImplementation(({ data }) => ({ ...RULE, ...data }));
    const prisma = {
      feeRule: {
        findUnique: jest.fn().mockResolvedValue(existing),
        findMany: jest.fn().mockResolvedValue(siblings),
        update,
      },
    } as unknown as PrismaService;
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    return { svc: new AdminService(prisma, audit), update, audit, prisma };
  }

  it('updates a rule and records before/after in the audit log', async () => {
    const { svc, update, audit } = make();
    await svc.updateFeeRule('admin-1', 'rule-1', { feeMinor: 700 });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rule-1' },
        data: expect.objectContaining({ feeMinor: 700 }),
      }),
    );
    const entry = (audit.record as jest.Mock).mock.calls[0][0];
    expect(entry).toMatchObject({ action: 'FEE_RULE_UPDATED', entityId: 'rule-1' });
    expect(entry.metadata.before.feeMinor).toBe(500);
    expect(entry.metadata.after.feeMinor).toBe(700);
  });

  it('leaves omitted fields untouched', async () => {
    const { svc, update } = make();
    await svc.updateFeeRule('admin-1', 'rule-1', { label: 'Cheap seats' });
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      label: 'Cheap seats',
      minMinor: 0,
      maxMinor: 19_900,
      feeMinor: 500,
    });
  });

  it('rejects an unknown rule', async () => {
    const { svc } = make(null);
    await expect(svc.updateFeeRule('admin-1', 'nope', { feeMinor: 1 })).rejects.toBeInstanceOf(
      AppException,
    );
  });

  // An inverted band matches nothing. Because resolution falls through to the last tier,
  // every order in that range would silently be charged the top-band fee.
  it('rejects an upper bound at or below the lower bound', async () => {
    const { svc } = make();
    await expect(
      svc.updateFeeRule('admin-1', 'rule-1', { minMinor: 5_000, maxMinor: 5_000 }),
    ).rejects.toThrow(/greater than the lower bound/);
  });

  it('allows an open-ended top band', async () => {
    const { svc, update } = make();
    await svc.updateFeeRule('admin-1', 'rule-1', { minMinor: 100_000, maxMinor: null });
    expect(update.mock.calls[0][0].data.maxMinor).toBeNull();
  });

  // First-match resolution means an overlap makes the fee depend on row order.
  it('rejects a band overlapping another active rule in the same currency', async () => {
    const { svc } = make(RULE, [
      {
        id: 'rule-2',
        label: '₹200–₹499',
        minMinor: 20_000,
        maxMinor: 49_900,
        currency: 'INR',
        active: true,
      },
    ]);
    await expect(svc.updateFeeRule('admin-1', 'rule-1', { maxMinor: 25_000 })).rejects.toThrow(
      /overlaps the active rule/,
    );
  });

  it('treats an open-ended sibling as covering everything above its floor', async () => {
    const { svc } = make(RULE, [
      {
        id: 'top',
        label: '₹1000+',
        minMinor: 100_000,
        maxMinor: null,
        currency: 'INR',
        active: true,
      },
    ]);
    await expect(
      svc.updateFeeRule('admin-1', 'rule-1', { minMinor: 0, maxMinor: 150_000 }),
    ).rejects.toThrow(/overlaps the active rule/);
  });

  it('permits an overlap when the rule being saved is inactive', async () => {
    const { svc, update } = make(RULE, [
      {
        id: 'rule-2',
        label: 'other',
        minMinor: 0,
        maxMinor: 99_999,
        currency: 'INR',
        active: true,
      },
    ]);
    await svc.updateFeeRule('admin-1', 'rule-1', { active: false, maxMinor: 50_000 });
    expect(update).toHaveBeenCalled();
  });

  // Bands are compared only within a currency; 500 paise and 500 cents are unrelated sums.
  it('ignores rules in other currencies when checking overlap', async () => {
    const { svc, update, prisma } = make(RULE, []);
    await svc.updateFeeRule('admin-1', 'rule-1', { maxMinor: 30_000 });
    expect((prisma.feeRule.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
      currency: 'INR',
      active: true,
    });
    expect(update).toHaveBeenCalled();
  });
});
