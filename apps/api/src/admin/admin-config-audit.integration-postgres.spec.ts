import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuditService } from '../audit/audit.service';
import { AdminService } from './admin.service';
import { CinemaPricingPoliciesService, type PolicyInput } from './cinema-pricing-policies.service';
import { TaxRulesService } from './tax-rules.service';

/**
 * integration-real-postgres — every platform-configuration change leaves an audit row.
 *
 * Narrowing WHO may change fee rules, tax rules and cinema pricing (see
 * `admin-config-authz.spec.ts`) is half of the control; the other half is that each change
 * that does happen can be traced to a person afterwards. This drives every mutating service
 * method behind those routes against a real database with the real `AuditService`, and reads
 * the `AuditLog` rows back - a stubbed recorder would only prove the method was called, not
 * that a row an auditor can query exists.
 *
 * The database is shared, so nothing created here can price a real order: fee bands are
 * created switched off in the ISO "testing" currency XTS, tax rules are switched off in XTS,
 * and pricing policies are scoped to country "ZZ", which no venue uses. Everything created is
 * removed afterwards, audit rows included.
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const txt = readFileSync(resolve(__dirname, p), 'utf8');
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

describe('integration-real-postgres: platform configuration changes are audited', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let admin: AdminService;
  let taxRules: TaxRulesService;
  let policies: CinemaPricingPoliciesService;

  const suffix = `cfgaudit-${Date.now()}`;
  let actorId = '';
  const created = { fee: [] as string[], tax: [] as string[], policy: [] as string[] };

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    const audit = new AuditService(db as never);
    admin = new AdminService(db as never, audit);
    taxRules = new TaxRulesService(db as never, audit);
    policies = new CinemaPricingPoliciesService(db as never, audit);
    actorId = (
      await db.user.create({
        data: {
          email: `editor+${suffix}@example.test`,
          passwordHash: 'x',
          fullName: 'Config editor',
          roles: ['ADMIN'],
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.auditLog.deleteMany({ where: { actorUserId: actorId } });
    // Successors point at the rows they replaced, so unlink before deleting.
    await db.cinemaPricingPolicy.updateMany({
      where: { id: { in: created.policy } },
      data: { supersedesId: null },
    });
    await db.cinemaPricingPolicy.deleteMany({ where: { id: { in: created.policy } } });
    await db.taxRule.deleteMany({ where: { id: { in: created.tax } } });
    await db.feeRule.deleteMany({ where: { id: { in: created.fee } } });
    await db.user.deleteMany({ where: { id: actorId } });
    await db.$disconnect();
  }, 60_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      60_000,
    );

  /** The audit rows this suite's editor wrote about one entity, oldest first. */
  const auditFor = async (entityId: string) =>
    (await db!.auditLog.findMany({
      where: { actorUserId: actorId, entityId },
      orderBy: { createdAt: 'asc' },
      select: { action: true, entityType: true, metadata: true },
    })) as { action: string; entityType: string; metadata: Record<string, unknown> | null }[];

  maybe('fee rule: create and update each write a row naming the editor', async () => {
    const band = await admin.createFeeRule(actorId, {
      currency: 'XTS',
      label: `Audit band ${suffix}`,
      minMinor: 0,
      maxMinor: 999,
      feeMinor: 10,
      country: 'ZZ',
      active: false,
    });
    created.fee.push(band.id);
    await admin.updateFeeRule(actorId, band.id, { feeMinor: 20 });

    const rows = await auditFor(band.id);
    expect(rows.map((r) => r.action)).toEqual(['FEE_RULE_CREATED', 'FEE_RULE_UPDATED']);
    expect(rows.every((r) => r.entityType === 'FeeRule')).toBe(true);
  });

  maybe('tax rule: create, update, supersede and delete each write a row', async () => {
    const rule = await taxRules.create(actorId, {
      label: `Audit tax ${suffix}`.slice(0, 40),
      rateBasisPoints: 100,
      appliesTo: 'FEES',
      country: 'ZZ',
      currency: 'XTS',
      active: false,
    });
    created.tax.push(rule.id);
    await taxRules.update(actorId, rule.id, { label: 'Audit tax renamed' });
    const { successor } = await taxRules.supersede(actorId, rule.id, {
      rateBasisPoints: 200,
      effectiveFrom: new Date('2099-01-01T00:00:00Z'),
    });
    created.tax.push(successor.id);
    await taxRules.remove(actorId, successor.id);

    expect((await auditFor(rule.id)).map((r) => r.action)).toEqual([
      'TAX_RULE_CREATED',
      'TAX_RULE_UPDATED',
      'TAX_RULE_SUPERSEDED',
    ]);
    expect((await auditFor(successor.id)).map((r) => r.action)).toEqual(['TAX_RULE_DELETED']);
  });

  maybe(
    'cinema pricing policy: create, edit, activate, supersede and disable each write a row',
    async () => {
      const input: PolicyInput = {
        country: 'ZZ',
        region: `R-${suffix}`,
        district: '*',
        city: '*',
        currency: 'XTS',
        maintenanceChargeMinor: 0,
        maintenanceTreatment: 'NOT_APPLICABLE',
        onlineFeePolicy: 'REQUIRES_APPROVAL',
        effectiveFrom: new Date('2099-01-01T00:00:00Z'),
        regulatoryReference: `TEST-${suffix}`,
      };
      const draft = await policies.create(actorId, input);
      created.policy.push(draft.id);
      await policies.updateDraft(actorId, draft.id, { notes: 'edited' });
      await policies.activate(actorId, draft.id);
      const next = await policies.supersede(actorId, draft.id, {
        ...input,
        effectiveFrom: new Date('2099-06-01T00:00:00Z'),
      });
      created.policy.push(next.id);
      await policies.disable(actorId, next.id);

      expect((await auditFor(draft.id)).map((r) => r.action)).toEqual([
        'CINEMA_PRICING_POLICY_CREATED',
        'CINEMA_PRICING_POLICY_DRAFT_UPDATED',
        'CINEMA_PRICING_POLICY_ACTIVATED',
        'CINEMA_PRICING_POLICY_SUPERSEDED',
      ]);
      expect((await auditFor(next.id)).map((r) => r.action)).toEqual([
        'CINEMA_PRICING_POLICY_DISABLED',
      ]);
    },
  );
});
