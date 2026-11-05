import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RazorpayConnectService } from './razorpay-connect.service';

/**
 * integration-real-postgres - one Razorpay linked account belongs to one organization.
 *
 * Linking is the only place an operator-typed payee id enters the system (Stripe ids are
 * minted by Stripe for one organization). A silent reassignment would point one
 * organization's settlements at another's payee.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../../.env', '../../../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');

describe('integration-real-postgres: Razorpay linked-account ownership', () => {
  const url = loadDatabaseUrl();
  let db: InstanceType<typeof PrismaClient> | null = null;
  let service: RazorpayConnectService;
  let available = false;
  let orgA = '';
  let orgB = '';
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const stamp = Date.now();
  const idA = `acc_own${stamp}A`;
  const user = { id: 'user-x', email: 'x@example.test', roles: [] } as never;

  beforeAll(async () => {
    if (!url) return;
    try {
      db = new PrismaClient({ datasources: { db: { url } } });
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      return;
    }
    orgA = (
      await db!.organization.create({
        data: {
          name: `Own A ${stamp}`,
          slug: `own-a-${stamp}`,
          status: 'APPROVED',
          // Razorpay Route links only for organizations registered in India.
          registeredCountry: 'IN',
        },
      })
    ).id;
    orgB = (
      await db!.organization.create({
        data: {
          name: `Own B ${stamp}`,
          slug: `own-b-${stamp}`,
          status: 'APPROVED',
          registeredCountry: 'IN',
        },
      })
    ).id;
    const provider = {
      getConnectedAccount: async () => ({
        disabledReason: null,
        chargesEnabled: true,
        detailsSubmitted: true,
        payoutsEnabled: true,
        requirementsCurrentlyDue: [],
      }),
    };
    service = new RazorpayConnectService(
      db as never,
      { assertMember: async () => undefined } as never,
      { get: () => provider } as never,
      { get: () => true } as never,
      { record: async (e: never) => void audits.push(e) } as never,
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.organizerPaymentAccount.deleteMany({
      where: { organizationId: { in: [orgA, orgB] } },
    });
    await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await db.$disconnect();
  });

  it('assigns to org A, refuses org B, allows A to re-save its own id', async () => {
    if (!available) return;
    const first = await service.linkAccount(user, orgA, idA);
    expect(first.linkedAccountId).toBe(idA);

    await expect(service.linkAccount(user, orgB, idA)).rejects.toMatchObject({ status: 409 });
    expect(await db!.organizerPaymentAccount.count({ where: { organizationId: orgB } })).toBe(0);
    const refusal = audits.find((a) => a.action === 'RAZORPAY_ACCOUNT_LINK_REFUSED');
    expect(refusal?.metadata).toMatchObject({ linkedAccountId: idA, ownedByOrganizationId: orgA });

    const again = await service.linkAccount(user, orgA, ` ${idA} `);
    expect(again.linkedAccountId).toBe(idA);
    expect(await db!.organizerPaymentAccount.count({ where: { providerAccountId: idA } })).toBe(1);
  });

  it('lets B link a different id, and lets A move to a new id freeing the old one', async () => {
    if (!available) return;
    const idB = `acc_own${stamp}B`;
    expect((await service.linkAccount(user, orgB, idB)).linkedAccountId).toBe(idB);
    const idA2 = `acc_own${stamp}C`;
    await service.linkAccount(user, orgA, idA2);
    expect((await service.linkAccount(user, orgB, idA)).linkedAccountId).toBe(idA);
  });

  it('serialises two organizations racing for the same new id: exactly one wins', async () => {
    if (!available) return;
    const raced = `acc_own${stamp}R`;
    const results = await Promise.allSettled([
      service.linkAccount(user, orgA, raced),
      service.linkAccount(user, orgB, raced),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db!.organizerPaymentAccount.count({ where: { providerAccountId: raced } })).toBe(
      1,
    );
  });

  it('does not treat another provider with the same text as a conflict', async () => {
    if (!available) return;
    const shared = `acct_own${stamp}S`;
    await db!.organizerPaymentAccount.create({
      data: { organizationId: orgA, provider: 'stripe', providerAccountId: shared },
    });
    expect((await service.linkAccount(user, orgB, shared)).linkedAccountId).toBe(shared);
  });
});
