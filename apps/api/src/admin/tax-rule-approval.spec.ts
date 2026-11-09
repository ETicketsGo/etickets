import { TaxRulesService, needsApproval } from './tax-rules.service';

/**
 * AR-56: one person could switch on the tax every buyer pays.
 *
 * Tax rules needed PLATFORM_CONFIG and a fresh second factor - one administrator, alone, could
 * turn GST on (adding about 18% of the fee to every Indian order) or move a live rate. Fee
 * schedules already needed a second person (AR-09). Now a change that STARTS or CHANGES a
 * charge is filed by one administrator and applied only when a different one approves it.
 *
 * What must NOT change: switching a rule off (how a wrong rate is stopped), editing a draft,
 * and the state of every rule already in the database.
 */

type Row = Record<string, unknown> & { id: string; updatedAt: Date };

const T0 = new Date('2026-11-01T00:00:00.000Z');

const LIVE: Row = {
  id: 'tr-live',
  label: 'GST',
  rateBasisPoints: 1800,
  appliesTo: 'FEES',
  taxGroup: '',
  country: 'IN',
  region: '*',
  currency: 'INR',
  category: '*',
  minUnitMinor: null,
  maxUnitMinor: null,
  inclusive: false,
  split: 'CGST_SGST',
  priority: 100,
  effectiveFrom: new Date('2025-09-22T00:00:00.000Z'),
  effectiveTo: null,
  active: true,
  createdAt: T0,
  updatedAt: T0,
};
const DRAFT: Row = { ...LIVE, id: 'tr-draft', active: false };

/** A small in-memory Prisma: enough of taxRule and taxRuleChange to run the real service. */
function harness(seed: Row[] = [LIVE, DRAFT]) {
  const rules = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  const changes = new Map<string, Row>();
  let clock = T0.getTime();
  const tick = () => new Date((clock += 1000));
  let seq = 0;
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const prisma: Record<string, unknown> = {
    taxRule: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        rules.get(where.id) ? { ...rules.get(where.id)! } : null,
      findMany: async () => [...rules.values()],
      create: async ({ data }: { data: Row }) => {
        const row = { ...data, id: `tr-${++seq}`, createdAt: tick(), updatedAt: tick() } as Row;
        rules.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = { ...rules.get(where.id)!, ...data, updatedAt: tick() };
        rules.set(where.id, row);
        return { ...row };
      },
      delete: async ({ where }: { where: { id: string } }) => rules.delete(where.id),
    },
    taxRuleChange: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          status: 'PENDING_APPROVAL',
          submittedAt: tick(),
          ...data,
          id: `tc-${++seq}`,
        } as Row;
        changes.set(row.id, row);
        return { ...row };
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        changes.get(where.id) ? { ...changes.get(where.id)! } : null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        [...changes.values()].filter((c) => matches(c, where)),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const row = changes.get(where.id);
        if (!row || !matches(row, where)) return { count: 0 };
        changes.set(where.id, { ...row, ...data });
        return { count: 1 };
      },
    },
    $executeRaw: async () => 0,
  };
  prisma.$transaction = async (arg: unknown) =>
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg as unknown[]);

  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    recordInTransaction: jest.fn().mockResolvedValue(undefined),
    afterCommit: jest.fn(),
  };
  const service = new TaxRulesService(prisma as never, audit as never);
  return { service, rules, changes, audit };
}

const MAKER = 'admin-maker';
const CHECKER = 'admin-checker';

describe('AR-56: tax rule maker-checker', () => {
  describe('switching a rule ON needs a second person', () => {
    it('files the activation instead of applying it, and the rule stays off', async () => {
      const { service, rules, changes } = harness();
      const result = await service.update(MAKER, 'tr-draft', { active: true });
      expect(rules.get('tr-draft')!.active).toBe(false);
      expect(result).toMatchObject({ active: false, pendingChange: { action: 'UPDATE' } });
      expect([...changes.values()]).toEqual([
        expect.objectContaining({
          taxRuleId: 'tr-draft',
          status: 'PENDING_APPROVAL',
          submittedByUserId: MAKER,
          payload: { active: true },
        }),
      ]);
    });

    it('creating a rule with active: true creates it OFF and files the activation', async () => {
      const { service, rules, changes } = harness([]);
      const created = await service.create(MAKER, {
        label: 'GST',
        rateBasisPoints: 1800,
        appliesTo: 'FEES',
        active: true,
      });
      expect(rules.get(created.id)!.active).toBe(false);
      expect([...changes.values()][0]).toMatchObject({
        taxRuleId: created.id,
        payload: { active: true },
      });
    });

    it('the maker cannot approve their own change, whatever they hold', async () => {
      const { service, rules, audit } = harness();
      const { pendingChange } = (await service.update(MAKER, 'tr-draft', { active: true })) as {
        pendingChange: { id: string };
      };
      await expect(service.approveChange(MAKER, pendingChange.id)).rejects.toMatchObject({
        response: expect.objectContaining({
          details: expect.objectContaining({ reason: 'NOT_INDEPENDENT' }),
        }),
      });
      expect(rules.get('tr-draft')!.active).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'TAX_RULE_CHANGE_APPROVAL_REFUSED' }),
      );
    });

    it('a different approver switches it on, and the record names both people', async () => {
      const { service, rules, changes, audit } = harness();
      const { pendingChange } = (await service.update(MAKER, 'tr-draft', { active: true })) as {
        pendingChange: { id: string };
      };
      const result = await service.approveChange(CHECKER, pendingChange.id, 'Checked the GSTIN');
      expect(result).toMatchObject({ status: 'APPROVED' });
      expect(rules.get('tr-draft')!.active).toBe(true);
      expect(changes.get(pendingChange.id)).toMatchObject({
        status: 'APPROVED',
        decidedByUserId: CHECKER,
        submittedByUserId: MAKER,
      });
      expect(audit.recordInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'TAX_RULE_TOGGLED',
          actorUserId: CHECKER,
          metadata: expect.objectContaining({
            submittedByUserId: MAKER,
            approvedByUserId: CHECKER,
          }),
        }),
      );
    });

    it('cannot be approved twice', async () => {
      const { service } = harness();
      const { pendingChange } = (await service.update(MAKER, 'tr-draft', { active: true })) as {
        pendingChange: { id: string };
      };
      await service.approveChange(CHECKER, pendingChange.id);
      await expect(service.approveChange('admin-third', pendingChange.id)).rejects.toThrow(
        /not waiting for approval/i,
      );
    });

    it('refuses to apply a change to a rule that moved after it was filed', async () => {
      const { service, rules } = harness();
      const { pendingChange } = (await service.update(MAKER, 'tr-draft', { active: true })) as {
        pendingChange: { id: string };
      };
      // Somebody edits the draft's rate after the activation was filed.
      await service.update(MAKER, 'tr-draft', { rateBasisPoints: 2800 });
      await expect(service.approveChange(CHECKER, pendingChange.id)).rejects.toThrow(
        /changed after the change was filed/i,
      );
      expect(rules.get('tr-draft')!.active).toBe(false);
    });

    it('a rejection needs a reason, comes from somebody else, and changes nothing', async () => {
      const { service, rules, changes } = harness();
      const { pendingChange } = (await service.update(MAKER, 'tr-draft', { active: true })) as {
        pendingChange: { id: string };
      };
      await expect(service.rejectChange(CHECKER, pendingChange.id, 'no')).rejects.toThrow(/why/i);
      await expect(
        service.rejectChange(MAKER, pendingChange.id, 'Changed my mind'),
      ).rejects.toThrow(/cannot reject/i);
      await service.rejectChange(CHECKER, pendingChange.id, 'GSTIN not on file yet');
      expect(changes.get(pendingChange.id)!.status).toBe('REJECTED');
      expect(rules.get('tr-draft')!.active).toBe(false);
    });

    it('only its maker may withdraw it', async () => {
      const { service, changes } = harness();
      const { pendingChange } = (await service.update(MAKER, 'tr-draft', { active: true })) as {
        pendingChange: { id: string };
      };
      await expect(service.withdrawChange(CHECKER, pendingChange.id)).rejects.toThrow(
        /only the administrator who filed/i,
      );
      await service.withdrawChange(MAKER, pendingChange.id);
      expect(changes.get(pendingChange.id)!.status).toBe('WITHDRAWN');
    });
  });

  describe('materially changing a LIVE rule needs a second person', () => {
    it.each([
      ['region', { region: 'TG' }],
      ['country', { country: 'US' }],
      ['currency', { currency: 'USD' }],
      ['dates', { effectiveTo: new Date('2027-01-01T00:00:00.000Z') }],
      ['priority', { priority: 5 }],
    ])('files a %s change on a live rule rather than applying it', async (_name, patch) => {
      const { service, rules, changes } = harness();
      const before = { ...rules.get('tr-live')! };
      await service.update(MAKER, 'tr-live', patch);
      expect(rules.get('tr-live')).toEqual(before);
      expect(changes.size).toBe(1);
    });

    it('applies the filed scope change on approval', async () => {
      const { service, rules } = harness();
      const { pendingChange } = (await service.update(MAKER, 'tr-live', {
        effectiveTo: new Date('2027-01-01T00:00:00.000Z'),
      })) as { pendingChange: { id: string } };
      await service.approveChange(CHECKER, pendingChange.id);
      expect(rules.get('tr-live')!.effectiveTo).toEqual(new Date('2027-01-01T00:00:00.000Z'));
    });

    it('files superseding a live rate, and the approval closes old and opens new at one instant', async () => {
      const at = new Date('2026-12-01T00:00:00.000Z');
      const { service, rules } = harness();
      const filed = (await service.supersede(MAKER, 'tr-live', {
        rateBasisPoints: 500,
        effectiveFrom: at,
      })) as { successor: unknown; pendingChange: { id: string; action: string } };
      expect(filed.successor).toBeNull();
      expect(filed.pendingChange.action).toBe('SUPERSEDE');
      expect(rules.get('tr-live')!.effectiveTo).toBeNull();
      expect(rules.size).toBe(2);

      const approved = (await service.approveChange(
        CHECKER,
        filed.pendingChange.id,
      )) as unknown as {
        successor: Row;
      };
      expect(rules.get('tr-live')!.effectiveTo).toEqual(at);
      expect(approved.successor).toMatchObject({
        rateBasisPoints: 500,
        effectiveFrom: at,
        active: true,
        split: 'CGST_SGST',
        appliesTo: 'FEES',
      });
    });
  });

  describe('what stays immediate', () => {
    it('switching a live rule OFF is never held for approval', async () => {
      const { service, rules, changes } = harness();
      await service.update(MAKER, 'tr-live', { active: false });
      expect(rules.get('tr-live')!.active).toBe(false);
      expect(changes.size).toBe(0);
    });

    it('editing a draft, relabelling a live rule and superseding a draft apply at once', async () => {
      const { service, rules, changes } = harness();
      await service.update(MAKER, 'tr-draft', { rateBasisPoints: 500, region: 'TG' });
      await service.update(MAKER, 'tr-live', { label: 'GST on fees' });
      await service.supersede(MAKER, 'tr-draft', {
        rateBasisPoints: 1200,
        effectiveFrom: new Date('2026-12-01T00:00:00.000Z'),
      });
      expect(rules.get('tr-draft')).toMatchObject({ rateBasisPoints: 500, region: 'TG' });
      expect(rules.get('tr-live')!.label).toBe('GST on fees');
      expect(changes.size).toBe(0);
    });

    it('still refuses an in-place rate edit on a live rule (supersede it instead)', async () => {
      const { service } = harness();
      await expect(service.update(MAKER, 'tr-live', { rateBasisPoints: 500 })).rejects.toThrow(
        /supersede/i,
      );
    });

    it('leaves every existing rule exactly as it is until somebody acts', async () => {
      const { service, rules } = harness();
      const before = [...rules.values()].map((r) => ({ ...r }));
      const listed = await service.list();
      expect(listed.map(({ inForceNow: _x, ...r }) => r)).toEqual(before);
    });
  });

  describe('needsApproval', () => {
    const live = { ...LIVE } as never;
    const draft = { ...DRAFT } as never;
    it('is false for no-op patches that repeat the current values', () => {
      expect(needsApproval(live, { region: '*', effectiveFrom: LIVE.effectiveFrom as Date })).toBe(
        false,
      );
    });
    it('is false for switching off, even alongside other fields', () => {
      expect(needsApproval(live, { active: false, region: 'TG' })).toBe(false);
    });
    it('is true for switching on, false for editing a draft', () => {
      expect(needsApproval(draft, { active: true })).toBe(true);
      expect(needsApproval(draft, { region: 'TG' })).toBe(false);
    });
  });
});
