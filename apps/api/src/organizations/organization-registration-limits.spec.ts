import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import {
  MAX_PENDING_ORGANIZATIONS_PER_ACCOUNT,
  registrationDigestIntent,
  registrationLockKey,
} from './organization-limits';

/**
 * How many organizations one account may have waiting, and what the admins are sent.
 *
 * ── WHY ANY OF THIS ────────────────────────────────────────────────────────────────
 * A new organization cannot sell until approved, so a flood of registrations takes no money.
 * It does bury the genuine organizers waiting for review — and each registration emailed every
 * admin, so enough of them would spend the day's sending allowance (200 on a sandboxed SES
 * account) and the booking confirmations after them would not go out.
 */

function harness(pending: number) {
  const order: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async () => {
      order.push('lock');
      return 1;
    }),
    organization: {
      count: jest.fn(async () => {
        order.push('count');
        return pending;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        order.push('create');
        return { id: 'org-new', name: data.name, contactEmail: data.contactEmail };
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    user: { update: jest.fn(async () => ({})) },
  };
  const notifyAdmins = jest.fn(
    async (_type: string, _payload: Record<string, unknown>, _options?: { intentKey?: string }) =>
      1,
  );
  const service = new OrganizationsService(
    prisma as never,
    {} as never,
    { record: async () => undefined } as never,
    { notifyAdmins } as never,
    { get: () => undefined } as never,
  );
  return { service, tx, prisma, notifyAdmins, order };
}

const owner = { id: 'user-1', email: 'owner@example.test', roles: ['CUSTOMER'] } as never;
const form = { name: 'Lantern Theatre Company', contactEmail: 'hello@lantern.test' } as never;

describe('organizations awaiting review, per account', () => {
  it.each([0, 1])('allows a registration when %i are already pending', async (pending) => {
    const { service, tx } = harness(pending);
    await expect(service.register(owner, form)).resolves.toMatchObject({ id: 'org-new' });
    expect(tx.organization.create).toHaveBeenCalledTimes(1);
  });

  it(`refuses a registration once ${MAX_PENDING_ORGANIZATIONS_PER_ACCOUNT} are pending`, async () => {
    const { service, tx } = harness(MAX_PENDING_ORGANIZATIONS_PER_ACCOUNT);
    await expect(service.register(owner, form)).rejects.toMatchObject({
      code: 'ORGANIZATION_LIMIT_REACHED',
      details: { pending: 2, limit: MAX_PENDING_ORGANIZATIONS_PER_ACCOUNT },
    });
    expect(tx.organization.create).not.toHaveBeenCalled();
  });

  it('counts only PENDING organizations this account owns', async () => {
    // An agency with approved brands is not waiting on anything; those must not count.
    const { service, tx } = harness(0);
    await service.register(owner, form);
    expect(tx.organization.count).toHaveBeenCalledWith({
      where: {
        status: 'PENDING',
        members: { some: { userId: 'user-1', role: 'ORGANIZER_OWNER' } },
      },
    });
  });

  it('takes the account’s lock before counting, so two at once cannot both slip under', async () => {
    const { service, tx, order } = harness(0);
    await service.register(owner, form);
    expect(order).toEqual(['lock', 'count', 'create']);
    // The lock is per ACCOUNT: one organizer registering does not queue behind another.
    expect(tx.$executeRaw.mock.calls[0]).toContain(registrationLockKey('user-1'));
  });
});

describe('the admin email', () => {
  afterEach(() => jest.useRealTimers());

  it('is keyed to the hour, so a burst of registrations sends one email per admin', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T14:25:00Z'));
    const { service, notifyAdmins } = harness(0);
    await service.register(owner, form);
    expect(notifyAdmins.mock.calls[0][2]).toEqual({
      intentKey: 'organization-registered:2026-09-10T14',
    });
  });

  it('shares a key within the hour and not across hours', () => {
    const early = registrationDigestIntent(new Date('2026-09-10T14:00:01Z'));
    const late = registrationDigestIntent(new Date('2026-09-10T14:59:59Z'));
    const next = registrationDigestIntent(new Date('2026-09-10T15:00:00Z'));
    expect(early).toBe(late);
    expect(next).not.toBe(late);
  });

  it('is not sent for a registration the cap refused', async () => {
    const { service, notifyAdmins } = harness(MAX_PENDING_ORGANIZATIONS_PER_ACCOUNT);
    await expect(service.register(owner, form)).rejects.toBeDefined();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });
});

describe('the registration route', () => {
  it('is rate limited to five an hour', () => {
    const handler = OrganizationsController.prototype.register;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60 * 60 * 1000);
  });
});
