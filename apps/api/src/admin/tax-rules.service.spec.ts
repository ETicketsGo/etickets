import { TaxRulesService } from './tax-rules.service';

/**
 * Editing tax rules from the admin console.
 *
 * ── WHAT THESE ARE ABOUT ───────────────────────────────────────────────────────────
 * Not arithmetic — the calculator's tests cover that. These are about what an administrator
 * is allowed to do to a rule that is charging real customers, which is a different question
 * and has a different answer: as little as possible in place.
 *
 * A booking snapshots the tax it was charged, so editing a live rate corrupts no money. What
 * it destroys is the answer to "what were we charging in March, and why" — and that is the
 * question an auditor actually asks.
 */
const LIVE = {
  id: 'tr-1',
  label: 'GST',
  rateBasisPoints: 1800,
  appliesTo: 'TICKETS',
  taxGroup: 'ADMISSION',
  country: 'India',
  region: '*',
  currency: 'INR',
  category: 'MOVIE',
  minUnitMinor: 10001,
  maxUnitMinor: null,
  inclusive: true,
  split: 'CGST_SGST',
  priority: 11,
  effectiveFrom: new Date('2025-09-22T00:00:00.000Z'),
  effectiveTo: null,
  active: true,
};

function setup(existing: Record<string, unknown> | null = LIVE) {
  const update = jest.fn().mockImplementation(async ({ data }) => ({ ...existing, ...data }));
  const create = jest.fn().mockImplementation(async ({ data }) => ({ id: 'tr-2', ...data }));
  const remove = jest.fn().mockResolvedValue({ id: 'tr-1' });
  const prisma = {
    taxRule: {
      findUnique: jest.fn().mockResolvedValue(existing),
      findMany: jest.fn().mockResolvedValue(existing ? [existing] : []),
      update,
      create,
      delete: remove,
    },
    $transaction: (ops: unknown[]) => Promise.all(ops),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new TaxRulesService(prisma as never, audit as never);
  return { service, prisma, update, create, remove, audit };
}

describe('TaxRulesService', () => {
  describe('list', () => {
    it('says whether a rule is in force RIGHT NOW, not merely switched on', async () => {
      /*
        `active` alone misleads in both directions: a rule can be active and not yet started,
        or active and long superseded. An administrator asking "what are we charging today"
        needs the answer rather than the flag.
      */
      const { service } = setup({ ...LIVE, effectiveFrom: new Date('2099-01-01') });
      const [rule] = await service.list();
      expect(rule.active).toBe(true);
      expect(rule.inForceNow).toBe(false);
    });

    it('counts a superseded rule as no longer in force', async () => {
      const { service } = setup({ ...LIVE, effectiveTo: new Date('2020-01-01') });
      const [rule] = await service.list();
      expect(rule.inForceNow).toBe(false);
    });

    it('counts an open-ended live rule as in force', async () => {
      const { service } = setup();
      const [rule] = await service.list();
      expect(rule.inForceNow).toBe(true);
    });
  });

  describe('create', () => {
    it('creates a rule switched OFF unless asked otherwise', async () => {
      // Adding a row and charging tax with it are different decisions. A form that does both
      // in one click will eventually be submitted by somebody who meant only the first.
      const { service, create } = setup(null);
      await service.create('admin-1', {
        label: 'GST',
        rateBasisPoints: 1800,
        appliesTo: 'TICKETS',
      });
      expect(create.mock.calls[0][0].data.active).toBe(false);
    });

    it('refuses a band that can never match anything', async () => {
      const { service } = setup(null);
      await expect(
        service.create('admin-1', {
          label: 'GST',
          rateBasisPoints: 1800,
          appliesTo: 'TICKETS',
          minUnitMinor: 50000,
          maxUnitMinor: 10000,
        }),
      ).rejects.toThrow(/never matches/i);
    });

    it('refuses a rate above 100%, which is a decimal-point slip', async () => {
      // Rates are basis points. Somebody typing 18000 meant 18%, and the difference is a
      // hundredfold overcharge that no other check would catch.
      const { service } = setup(null);
      await expect(
        service.create('admin-1', {
          label: 'GST',
          rateBasisPoints: 18_000,
          appliesTo: 'TICKETS',
        }),
      ).rejects.toThrow(/typo|basis points/i);
    });

    it('records who created it', async () => {
      const { service, audit } = setup(null);
      await service.create('admin-1', {
        label: 'GST',
        rateBasisPoints: 1800,
        appliesTo: 'TICKETS',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: 'admin-1', action: 'TAX_RULE_CREATED' }),
      );
    });
  });

  describe('update', () => {
    it('REFUSES to change the rate of a live rule', async () => {
      /*
        The central rule of this service. Editing a live rate in place leaves no record that
        the old one ever existed, so the bookings taxed under it become unexplainable.
      */
      const { service } = setup();
      await expect(service.update('admin-1', 'tr-1', { rateBasisPoints: 500 })).rejects.toThrow(
        /supersede/i,
      );
    });

    it('refuses to change the basis or the band of a live rule either', async () => {
      // Same reasoning: what a rule is levied on is as much a part of "what were we
      // charging" as the percentage.
      const { service } = setup();
      await expect(service.update('admin-1', 'tr-1', { inclusive: false })).rejects.toThrow(
        /supersede/i,
      );
      await expect(service.update('admin-1', 'tr-1', { maxUnitMinor: 50000 })).rejects.toThrow(
        /supersede/i,
      );
    });

    it('ALLOWS the same edits on a draft, which never charged anybody', async () => {
      const { service, update } = setup({ ...LIVE, active: false });
      await service.update('admin-1', 'tr-1', { rateBasisPoints: 500 });
      expect(update.mock.calls[0][0].data.rateBasisPoints).toBe(500);
    });

    it('always allows switching a rule off, which is how you stop charging', async () => {
      // The one edit that must never be blocked: if a rate is wrong, turning it off has to
      // be possible immediately, without first constructing a successor.
      const { service, update } = setup();
      await service.update('admin-1', 'tr-1', { active: false });
      expect(update.mock.calls[0][0].data.active).toBe(false);
    });

    it('allows relabelling a live rule, which changes no charge', async () => {
      const { service, update } = setup();
      await service.update('admin-1', 'tr-1', { label: 'GST (cinema)' });
      expect(update.mock.calls[0][0].data.label).toBe('GST (cinema)');
    });
  });

  describe('supersede', () => {
    it('closes the old rule exactly where the new one opens', async () => {
      /*
        `effectiveTo` is exclusive and `effectiveFrom` inclusive, so at the changeover
        instant exactly one rule applies — never both, never neither. A gap charges nothing
        and an overlap charges twice, and both are silent.
      */
      const at = new Date('2026-04-01T00:00:00.000Z');
      const { service, update, create } = setup();
      await service.supersede('admin-1', 'tr-1', { rateBasisPoints: 500, effectiveFrom: at });

      expect(update.mock.calls[0][0].data.effectiveTo).toEqual(at);
      expect(create.mock.calls[0][0].data.effectiveFrom).toEqual(at);
      expect(create.mock.calls[0][0].data.rateBasisPoints).toBe(500);
    });

    it('carries every other property across, so only the rate moved', async () => {
      const { service, create } = setup();
      await service.supersede('admin-1', 'tr-1', {
        rateBasisPoints: 500,
        effectiveFrom: new Date('2026-04-01'),
      });
      const successor = create.mock.calls[0][0].data;
      expect(successor).toMatchObject({
        category: 'MOVIE',
        minUnitMinor: 10001,
        inclusive: true,
        split: 'CGST_SGST',
        taxGroup: 'ADMISSION',
      });
    });

    it('inherits whether it was charging, rather than deciding for the operator', async () => {
      // Superseding a live rule must not silently stop charging, and superseding a draft
      // must not silently start.
      const { service, create } = setup({ ...LIVE, active: false });
      await service.supersede('admin-1', 'tr-1', {
        rateBasisPoints: 500,
        effectiveFrom: new Date('2026-04-01'),
      });
      expect(create.mock.calls[0][0].data.active).toBe(false);
    });

    it('refuses to supersede a rule that already ended before that date', async () => {
      const { service } = setup({ ...LIVE, effectiveTo: new Date('2026-01-01') });
      await expect(
        service.supersede('admin-1', 'tr-1', {
          rateBasisPoints: 500,
          effectiveFrom: new Date('2026-04-01'),
        }),
      ).rejects.toThrow(/already ended/i);
    });
  });

  describe('remove', () => {
    it('refuses to delete a live rule', async () => {
      const { service } = setup();
      await expect(service.remove('admin-1', 'tr-1')).rejects.toThrow(/cannot be deleted/i);
    });

    it('deletes a rule that is switched off', async () => {
      const { service, remove } = setup({ ...LIVE, active: false });
      await service.remove('admin-1', 'tr-1');
      expect(remove).toHaveBeenCalledWith({ where: { id: 'tr-1' } });
    });
  });
});
