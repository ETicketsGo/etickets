import type { AddressInfo } from 'node:net';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ADMIN_PRESETS, AdminPermission } from '@eticketsgo/shared-types';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AdminBillingController } from './billing-admin.controller';

/**
 * Who may do what on /admin/billing, over real HTTP through the real RolesGuard and
 * AdminPermissionGuard. Services are self-naming stubs, so a 2xx proves the handler ran and an
 * empty call log proves a refused call did nothing. The second-factor half (every write needs a
 * recent check) is held by admin/step-up-routes.spec.ts through the real MfaGuard.
 */

type Actor = { roles: string[]; grants: string[] };

class HeaderUserGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const raw = req.headers['x-test-actor'] as string | undefined;
    if (raw) {
      const a = JSON.parse(raw) as Actor & { id: string };
      req.user = { id: a.id, email: `${a.id}@t.test`, fullName: a.id, roles: a.roles };
    }
    return true;
  }
}

const P = AdminPermission;
const ACTORS: Record<string, Actor> = {
  reader: { roles: ['ADMIN'], grants: [P.BILLING_READ] },
  manager: { roles: ['ADMIN'], grants: [P.BILLING_MANAGE] },
  adjuster: { roles: ['ADMIN'], grants: [P.BILLING_ADJUST] },
  granter: { roles: ['ADMIN'], grants: [P.ENTITLEMENT_GRANT] },
  crmAgent: { roles: ['ADMIN'], grants: [P.CRM_AGENT, P.CRM_MANAGER] },
  financeRead: { roles: ['ADMIN'], grants: [P.FINANCE_READ, P.PAYOUT_MANAGE, P.PLATFORM_CONFIG] },
  customer: { roles: ['CUSTOMER'], grants: [] },
  organizer: { roles: ['ORGANIZER_OWNER'], grants: [] },
  superAdmin: { roles: ['ADMIN', 'SUPER_ADMIN'], grants: [] },
};

type Route = { method: string; path: string; template: string; needs: string; body?: unknown };

const reason = 'Pilot partner, agreed by owner';
const ROUTES: Route[] = [
  {
    method: 'GET',
    path: '/admin/billing/plans',
    template: 'GET admin/billing/plans',
    needs: P.BILLING_READ,
  },
  {
    method: 'GET',
    path: '/admin/billing/subscriptions',
    template: 'GET admin/billing/subscriptions',
    needs: P.BILLING_READ,
  },
  {
    method: 'GET',
    path: '/admin/billing/accounts/o1',
    template: 'GET admin/billing/accounts/:organizationId',
    needs: P.BILLING_READ,
  },
  {
    method: 'GET',
    path: '/admin/billing/metrics',
    template: 'GET admin/billing/metrics',
    needs: P.BILLING_READ,
  },
  {
    method: 'POST',
    path: '/admin/billing/catalog/load-provisional',
    template: 'POST admin/billing/catalog/load-provisional',
    needs: P.BILLING_MANAGE,
    body: {},
  },
  {
    method: 'PATCH',
    path: '/admin/billing/plans/p1',
    template: 'PATCH admin/billing/plans/:id',
    needs: P.BILLING_MANAGE,
    body: { name: 'Pro' },
  },
  {
    method: 'PUT',
    path: '/admin/billing/plans/p1/entitlements',
    template: 'PUT admin/billing/plans/:id/entitlements',
    needs: P.BILLING_MANAGE,
    body: { entitlements: [] },
  },
  {
    method: 'POST',
    path: '/admin/billing/prices',
    template: 'POST admin/billing/prices',
    needs: P.BILLING_MANAGE,
    body: { planId: 'p1', country: 'IN', currency: 'INR', interval: 'MONTH', amountMinor: 99900 },
  },
  {
    method: 'PATCH',
    path: '/admin/billing/prices/x1',
    template: 'PATCH admin/billing/prices/:id',
    needs: P.BILLING_MANAGE,
    body: { trialDays: 7 },
  },
  {
    method: 'POST',
    path: '/admin/billing/prices/x1/deactivate',
    template: 'POST admin/billing/prices/:id/deactivate',
    needs: P.BILLING_MANAGE,
  },
  {
    method: 'POST',
    path: '/admin/billing/accounts/o1/trial',
    template: 'POST admin/billing/accounts/:organizationId/trial',
    needs: P.BILLING_ADJUST,
    body: { planCode: 'PRO', days: 14, reason },
  },
  {
    method: 'POST',
    path: '/admin/billing/accounts/o1/complimentary',
    template: 'POST admin/billing/accounts/:organizationId/complimentary',
    needs: P.BILLING_ADJUST,
    body: { planCode: 'PREMIUM', reason },
  },
  {
    method: 'POST',
    path: '/admin/billing/accounts/o1/end-grant',
    template: 'POST admin/billing/accounts/:organizationId/end-grant',
    needs: P.BILLING_ADJUST,
    body: { reason },
  },
  {
    method: 'POST',
    path: '/admin/billing/accounts/o1/credits',
    template: 'POST admin/billing/accounts/:organizationId/credits',
    needs: P.BILLING_ADJUST,
    body: { amount: 500, reason, idempotencyKey: 'form-0001' },
  },
  {
    method: 'POST',
    path: '/admin/billing/accounts/o1/discounts',
    template: 'POST admin/billing/accounts/:organizationId/discounts',
    needs: P.BILLING_ADJUST,
    body: { percentOffBps: 2000, reason },
  },
  {
    method: 'POST',
    path: '/admin/billing/accounts/o1/overrides',
    template: 'POST admin/billing/accounts/:organizationId/overrides',
    needs: P.ENTITLEMENT_GRANT,
    body: { key: 'campaigns.automation', boolValue: true, reason },
  },
  {
    method: 'POST',
    path: '/admin/billing/overrides/v1/revoke',
    template: 'POST admin/billing/overrides/:id/revoke',
    needs: P.ENTITLEMENT_GRANT,
    body: { reason },
  },
  // Credit pack prices (owner decision 2026-10-27): read with BILLING_READ, change with
  // BILLING_MANAGE only - never BILLING_ADJUST, which Finance holds.
  {
    method: 'GET',
    path: '/admin/billing/credit-packs',
    template: 'GET admin/billing/credit-packs',
    needs: P.BILLING_READ,
  },
  {
    method: 'PUT',
    path: '/admin/billing/credit-packs/EMAIL_1K/prices/IN',
    template: 'PUT admin/billing/credit-packs/:packCode/prices/:country',
    needs: P.BILLING_MANAGE,
    body: { currency: 'INR', amountMinor: 100 },
  },
  {
    method: 'POST',
    path: '/admin/billing/credit-packs/EMAIL_1K/prices/IN/publish',
    template: 'POST admin/billing/credit-packs/:packCode/prices/:country/publish',
    needs: P.BILLING_MANAGE,
    body: {},
  },
  {
    method: 'POST',
    path: '/admin/billing/credit-packs/EMAIL_1K/prices/IN/unpublish',
    template: 'POST admin/billing/credit-packs/:packCode/prices/:country/unpublish',
    needs: P.BILLING_MANAGE,
    body: {},
  },
];

const HOLDER: Record<string, string> = {
  [P.BILLING_READ]: 'reader',
  [P.BILLING_MANAGE]: 'manager',
  [P.BILLING_ADJUST]: 'adjuster',
  [P.ENTITLEMENT_GRANT]: 'granter',
};

const calls: string[] = [];
function namedStub(token: unknown) {
  const name = typeof token === 'function' ? token.name : String(token);
  return new Proxy({} as Record<string, unknown>, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'constructor') return undefined;
      if (/^on[A-Z]|^beforeApplicationShutdown$/.test(prop)) return undefined;
      target[prop] ??= async () => {
        calls.push(`${name}.${prop}`);
        return { handledBy: `${name}.${prop}` };
      };
      return target[prop];
    },
  });
}

describe('admin billing: each write needs its own capability', () => {
  let app: INestApplication;
  let base = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [AdminBillingController] })
      .useMocker(namedStub)
      .compile();
    const reflector = new Reflector();
    const prisma = {
      adminGrant: {
        findMany: async ({ where }: { where: { userId: string } }) =>
          (ACTORS[where.userId]?.grants ?? []).map((permission) => ({ permission })),
      },
    };
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalGuards(
      new HeaderUserGuard(),
      new RolesGuard(reflector),
      new AdminPermissionGuard(reflector, prisma as never),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  async function call(actor: string, r: Route) {
    calls.length = 0;
    const res = await fetch(`${base}${r.path}`, {
      method: r.method,
      headers: {
        'content-type': 'application/json',
        'x-test-actor': JSON.stringify({ id: actor, ...ACTORS[actor] }),
      },
      body: r.body === undefined ? undefined : JSON.stringify(r.body),
    });
    return { status: res.status, ran: calls.length > 0 };
  }

  it('lists every route on the controller', () => {
    const proto = AdminBillingController.prototype as unknown as Record<string, unknown>;
    const actual = Object.getOwnPropertyNames(proto)
      .filter((k) => k !== 'constructor')
      .map((k) => {
        const fn = proto[k] as object;
        const m = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod;
        const p = Reflect.getMetadata(PATH_METADATA, fn) as string;
        return `${RequestMethod[m]} admin/billing/${p}`;
      })
      .sort();
    expect(actual).toEqual(ROUTES.map((r) => r.template).sort());
  });

  describe.each(ROUTES)('$method $path', (r) => {
    it(`runs for the ${r.needs} holder`, async () => {
      const { status, ran } = await call(HOLDER[r.needs], r);
      expect(status).toBeGreaterThanOrEqual(200);
      expect(status).toBeLessThan(300);
      expect(ran).toBe(true);
    });

    it('is refused, and runs nothing, for every other billing capability alone', async () => {
      for (const [cap, actor] of Object.entries(HOLDER)) {
        if (cap === r.needs) continue;
        const { status, ran } = await call(actor, r);
        expect({ actor, status, ran }).toEqual({ actor, status: 403, ran: false });
      }
    });

    it('is refused to the CRM desk, to finance and config holders, and to organizers and customers', async () => {
      for (const actor of ['crmAgent', 'financeRead', 'organizer', 'customer']) {
        const { status, ran } = await call(actor, r);
        expect({ actor, status, ran }).toEqual({ actor, status: 403, ran: false });
      }
    });

    it('runs for a super admin, who holds everything by role', async () => {
      const { status } = await call('superAdmin', r);
      expect(status).toBeLessThan(300);
    });

    it('opens to a ready-made bundle exactly when the bundle carries its capability', async () => {
      for (const [key, preset] of Object.entries(ADMIN_PRESETS)) {
        const actor = `preset:${key}`;
        ACTORS[actor] = { roles: ['ADMIN'], grants: [...preset.grants] };
        const { status } = await call(actor, r);
        expect({ key, allowed: status < 300 }).toEqual({
          key,
          allowed: (preset.grants as string[]).includes(r.needs),
        });
      }
    });
  });
});
