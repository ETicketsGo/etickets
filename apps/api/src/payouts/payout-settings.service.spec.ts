import { PayoutSettingsService } from './payout-settings.service';
import { AppException } from '../common/errors';

/**
 * The terms a settlement runs under, and who decides them.
 *
 * These were environment variables: one number for every organizer on the platform, changed
 * only by a deploy, with no record of who changed it. They are commercial terms - negotiated
 * per organizer and changed without a release - so they live in the database, resolve from
 * the organization then the platform then the environment, and every write is audited.
 */
const actor = { id: 'admin-1', email: 'a@t.test', fullName: 'A', roles: [] } as never;

function makeService(
  rows: Array<Record<string, unknown>> = [],
  envHoldDays: number | undefined = 7,
) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    payoutSetting: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn(
        async ({ where }: { where: { organizationId: string | null } }) =>
          rows.find((row) => (row.organizationId ?? null) === where.organizationId) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'ps1',
        ...data,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'ps1',
        ...data,
      })),
    },
    organization: { findUnique: jest.fn().mockResolvedValue({ id: 'org-1' }) },
  };
  const config = { get: () => envHoldDays };
  return {
    service: new PayoutSettingsService(prisma as never, audit as never, config as never),
    prisma,
    audit,
  };
}

describe('which terms apply to an organization', () => {
  it('falls back to the environment when nothing is configured', async () => {
    const { service } = makeService([]);
    const terms = await service.effectiveFor('org-1');
    expect(terms.holdDays).toBe(7);
    expect(terms.minPayoutMinor).toEqual({});
    expect(terms.source.holdDays).toBe('default');
  });

  it('prefers the platform row over the environment', async () => {
    const { service } = makeService([
      { organizationId: null, holdDays: 3, minPayoutMinor: { INR: 50_000 } },
    ]);
    const terms = await service.effectiveFor('org-1');
    expect(terms).toMatchObject({
      holdDays: 3,
      minPayoutMinor: { INR: 50_000 },
      source: { holdDays: 'platform' },
    });
  });

  it("prefers the organization's own row over the platform", async () => {
    const { service } = makeService([
      { organizationId: null, holdDays: 3, minPayoutMinor: { INR: 50_000 } },
      { organizationId: 'org-1', holdDays: 14, minPayoutMinor: null },
    ]);
    const terms = await service.effectiveFor('org-1');
    expect(terms.holdDays).toBe(14);
    expect(terms.source.holdDays).toBe('organization');
    // Each field resolves on its own: an override of the hold must not pin the minimum to
    // whatever it was the day somebody created the override.
    expect(terms.minPayoutMinor).toEqual({ INR: 50_000 });
    expect(terms.source.minPayoutMinor).toBe('platform');
  });

  it('reads a zero hold as a decision, not as absent', async () => {
    // "Payable as soon as the show is over" is a real term, and `?? ` on a zero would have
    // silently replaced it with the platform default.
    const { service } = makeService([
      { organizationId: null, holdDays: 7, minPayoutMinor: null },
      { organizationId: 'org-1', holdDays: 0, minPayoutMinor: null },
    ]);
    expect((await service.effectiveFor('org-1')).holdDays).toBe(0);
  });

  it('matches currencies whatever case they were stored in', async () => {
    const { service } = makeService([
      { organizationId: null, holdDays: 7, minPayoutMinor: { inr: 50_000 } },
    ]);
    expect((await service.effectiveFor('org-1')).minPayoutMinor).toEqual({ INR: 50_000 });
  });

  it("ignores another organization's override", async () => {
    const { service, prisma } = makeService([{ organizationId: null, holdDays: 5 }]);
    await service.effectiveFor('org-1');
    expect(prisma.payoutSetting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ organizationId: 'org-1' }, { organizationId: null }] },
      }),
    );
  });
});

describe('changing the terms', () => {
  it('records who changed what, with the values before and after', async () => {
    const { service, audit } = makeService([{ organizationId: null, holdDays: 7 }]);
    await service.update(actor, null, { holdDays: 10 });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PAYOUT_SETTINGS_UPDATED',
        metadata: expect.objectContaining({
          scope: 'platform',
          before: expect.objectContaining({ holdDays: 7 }),
          after: expect.objectContaining({ holdDays: 10 }),
        }),
      }),
    );
  });

  it('leaves a term alone when the write does not mention it', async () => {
    // A screen that edits the hold must not blank the minimum by omission.
    const { service, prisma } = makeService([
      { id: 'ps1', organizationId: null, holdDays: 7, minPayoutMinor: { INR: 50_000 } },
    ]);
    await service.update(actor, null, { holdDays: 9 });
    expect(prisma.payoutSetting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ holdDays: 9, minPayoutMinor: { INR: 50_000 } }),
      }),
    );
  });

  it('refuses a hold that is not a term but a refusal to pay', async () => {
    const { service } = makeService();
    await expect(service.update(actor, null, { holdDays: 400 })).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('refuses a negative or fractional hold', async () => {
    const { service } = makeService();
    await expect(service.update(actor, null, { holdDays: -1 })).rejects.toBeInstanceOf(
      AppException,
    );
    await expect(service.update(actor, null, { holdDays: 1.5 })).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('refuses a minimum that is not money', async () => {
    const { service } = makeService();
    await expect(
      service.update(actor, null, { minPayoutMinor: { RUPEES: 100 } }),
    ).rejects.toBeInstanceOf(AppException);
    await expect(
      service.update(actor, null, { minPayoutMinor: { INR: -100 } }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('refuses an override for an organization that does not exist', async () => {
    const { service, prisma } = makeService();
    prisma.organization.findUnique.mockResolvedValueOnce(null);
    await expect(service.update(actor, 'ghost', { holdDays: 1 })).rejects.toBeInstanceOf(
      AppException,
    );
  });
});
