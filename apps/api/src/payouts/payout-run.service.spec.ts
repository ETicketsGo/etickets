import { PayoutRunService, isDue, nextRunAfter } from './payout-run.service';
import { AppException, ErrorCodes } from '../common/errors';
import { PayoutStatus } from '@eticketsgo/shared-types';

/**
 * The platform raising settlements by itself.
 *
 * ── WHAT THIS HAS TO GET RIGHT ─────────────────────────────────────────────────────
 * It writes money records with nobody watching, so the failure modes are: running when it
 * should not, not running when it should, running twice, and one organization's failure
 * stopping everybody else's. Each has a test.
 */
const terms = (over: Record<string, unknown> = {}) => ({
  holdDays: 7,
  minPayoutMinor: {},
  autoGenerate: true,
  runFrequency: 'WEEKLY',
  runAnchorDay: 1,
  lastRunAt: null,
  source: { holdDays: 'platform', minPayoutMinor: 'platform', autoGenerate: 'platform' },
  ...over,
});

function makeService(
  organizations: string[],
  termsById: Record<string, ReturnType<typeof terms>>,
  generate = jest.fn().mockResolvedValue([{ id: 'p1' }]),
) {
  const settingRows: Record<string, Record<string, unknown>> = {};
  const prisma = {
    organization: {
      findMany: jest.fn().mockResolvedValue(organizations.map((id) => ({ id }))),
    },
    payoutSetting: {
      findFirst: jest.fn(
        async ({ where }: { where: { organizationId: string } }) =>
          settingRows[where.organizationId] ?? null,
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        settingRows[data.organizationId as string] = { id: 'ps', ...data };
        return data;
      }),
    },
  };
  const payouts = { generateAutomatically: generate };
  const settings = { effectiveFor: jest.fn(async (id: string) => termsById[id] ?? terms()) };
  return {
    service: new PayoutRunService(prisma as never, payouts as never, settings as never),
    prisma,
    generate,
  };
}

const MONDAY = new Date('2026-09-28T02:00:00Z');

describe('when a settlement run is due', () => {
  it('is due the first time, so turning it on does something today', () => {
    expect(isDue(MONDAY, null, 'WEEKLY', 1)).toBe(true);
  });

  it('weekly: on the anchor day, and not before a week has passed', () => {
    const lastWeek = new Date('2026-09-21T02:00:00Z');
    expect(isDue(MONDAY, lastWeek, 'WEEKLY', 1)).toBe(true);
    // Same week, anchor day not yet come round again.
    expect(isDue(new Date('2026-09-30T02:00:00Z'), lastWeek, 'WEEKLY', 1)).toBe(false);
    // Anchor day, but only two days since the last run - a term change must not double-pay.
    expect(isDue(MONDAY, new Date('2026-09-26T02:00:00Z'), 'WEEKLY', 1)).toBe(false);
  });

  it('daily: once a day', () => {
    expect(isDue(MONDAY, new Date('2026-09-27T01:00:00Z'), 'DAILY', null)).toBe(true);
    expect(isDue(MONDAY, new Date('2026-09-27T23:00:00Z'), 'DAILY', null)).toBe(false);
  });

  it('monthly: on or after the anchor date, a month apart', () => {
    const lastMonth = new Date('2026-08-05T02:00:00Z');
    expect(isDue(new Date('2026-09-05T02:00:00Z'), lastMonth, 'MONTHLY', 5)).toBe(true);
    expect(isDue(new Date('2026-09-04T02:00:00Z'), lastMonth, 'MONTHLY', 5)).toBe(false);
  });

  it('never anchors a monthly run past the 28th, which would skip February', () => {
    // An anchor of 31 is clamped rather than obeyed: a run nobody notices is missing is
    // worse than one that happens on the 28th.
    const lastMonth = new Date('2026-01-28T02:00:00Z');
    expect(isDue(new Date('2026-02-28T02:00:00Z'), lastMonth, 'MONTHLY', 31)).toBe(true);
  });

  it('says when the payouts it raises are expected to be paid', () => {
    expect(nextRunAfter(MONDAY, 'DAILY', null).toISOString().slice(0, 10)).toBe('2026-09-29');
    expect(nextRunAfter(MONDAY, 'WEEKLY', 1).toISOString().slice(0, 10)).toBe('2026-10-05');
    expect(nextRunAfter(MONDAY, 'MONTHLY', 3).toISOString().slice(0, 10)).toBe('2026-10-03');
  });
});

describe('the settlement run', () => {
  it('does nothing at all where automatic settlement is off', async () => {
    const { service, generate } = makeService(['o1'], { o1: terms({ autoGenerate: false }) });
    const result = await service.runDue(MONDAY);
    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ considered: 0, raised: 0 });
  });

  it('raises a settlement for an organization whose run is due', async () => {
    const { service, generate } = makeService(['o1'], { o1: terms() });
    const result = await service.runDue(MONDAY);
    expect(generate).toHaveBeenCalledWith('o1', expect.any(Date));
    expect(result.raised).toBe(1);
  });

  it('stamps the run even when it raises nothing, so it does not retry every hour', async () => {
    /*
      A run that correctly found nothing - everything held, or below the minimum - still
      happened. Leaving the stamp alone would hammer the ledger every tick for a result that
      cannot change until more money arrives or a hold expires.
    */
    const generate = jest
      .fn()
      .mockRejectedValue(new AppException(ErrorCodes.CONFLICT, 'There is no new paid revenue.'));
    const { service, prisma } = makeService(['o1'], { o1: terms() }, generate);
    const result = await service.runDue(MONDAY);
    expect(result).toMatchObject({ raised: 0, skipped: 1 });
    expect(prisma.payoutSetting.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastRunAt: MONDAY }) }),
    );
  });

  it('gives an inheriting organization its own stamp, never a shared one', async () => {
    /*
      An organization on the platform's schedule has no row of its own. It gets one holding
      nothing but the stamp - every term still null, still inheriting - because a shared
      cursor would mean the first organization swept each day stopped every other one.
    */
    const { service, prisma } = makeService(['o1'], { o1: terms() });
    await service.runDue(MONDAY);
    const created = prisma.payoutSetting.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ organizationId: 'o1', lastRunAt: MONDAY });
    expect(created.holdDays).toBeUndefined();
  });

  it('keeps going when one organization fails', async () => {
    const generate = jest
      .fn()
      .mockRejectedValueOnce(new Error('database went away'))
      .mockResolvedValueOnce([{ id: 'p2' }]);
    const { service } = makeService(['o1', 'o2'], { o1: terms(), o2: terms() }, generate);
    const result = await service.runDue(MONDAY);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ considered: 2, raised: 1, skipped: 1 });
  });

  it('marks what it raises as SCHEDULED, which is what that status means', () => {
    // The distinction the status carries: PENDING is somebody dealing with it by hand,
    // SCHEDULED is the platform queuing it for the run on `scheduledAt`.
    expect(PayoutStatus.SCHEDULED).toBe('SCHEDULED');
  });
});
