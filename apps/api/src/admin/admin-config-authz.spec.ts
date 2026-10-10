import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  RequestMethod,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ADMIN_PRESETS, AdminPermission } from '@eticketsgo/shared-types';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { RolesGuard } from '../auth/roles.guard';
import { OpsController } from '../ops/ops.controller';
import { AdminController } from './admin.controller';

/**
 * Who may read and who may change platform configuration - over real HTTP, through the real
 * guards.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * Fee rules, tax rules and cinema pricing policies live on `AdminController`, whose class guard
 * is `BOOKING_READ`, and none of their handlers declared a capability of its own. So the support
 * desk could add a fee band, switch on a tax rate or activate a regulated price ceiling.
 * Separately, `POST /admin/ops/maintenance` - which takes the storefront offline - inherited
 * `OPS_READ`.
 *
 * ── HOW THIS TEST SEES IT ──────────────────────────────────────────────────────────
 * The real `RolesGuard` and `AdminPermissionGuard` run against the real controllers, so the
 * decorators are resolved exactly as Nest resolves them in production (a handler's
 * `@RequiresAdmin` replacing the class's). Only two things are stubbed: who is calling (a header
 * standing in for the JWT), and the grant rows the permission guard reads. Every service is an
 * automatic stub that names itself, so a 2xx proves the handler actually ran.
 */

type Actor = { roles: string[]; grants: string[] };

/** A test-only stand-in for JwtAuthGuard: the caller is whoever the header says. */
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

const ACTORS: Record<string, Actor> = {
  /** The support desk. The account the defect was about. */
  bookingReadOnly: { roles: ['ADMIN'], grants: [AdminPermission.BOOKING_READ] },
  configReader: { roles: ['ADMIN'], grants: [AdminPermission.PLATFORM_CONFIG_READ] },
  configEditor: { roles: ['ADMIN'], grants: [AdminPermission.PLATFORM_CONFIG] },
  opsReader: { roles: ['ADMIN'], grants: [AdminPermission.OPS_READ] },
  /** Holds everything by role, with no grant rows at all. */
  superAdmin: { roles: ['ADMIN', 'SUPER_ADMIN'], grants: [] },
};

/*
  Every configuration route, whether it reads or writes, and a body the route's validation
  accepts - so an allowed call reaches the handler and answers 2xx rather than stopping at a 400
  that would prove nothing about the guard.
*/
const CONFIG_ROUTES: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  kind: 'read' | 'write';
  body?: unknown;
}[] = [
  { method: 'GET', path: '/admin/fee-rules', kind: 'read' },
  {
    method: 'POST',
    path: '/admin/fee-rules',
    kind: 'write',
    body: { currency: 'INR', label: 'Band', minMinor: 0, maxMinor: null, feeMinor: 0 },
  },
  { method: 'PATCH', path: '/admin/fee-rules/fr1', kind: 'write', body: { label: 'Band' } },
  { method: 'GET', path: '/admin/tax-rules', kind: 'read' },
  { method: 'GET', path: '/admin/tax-rules/readiness', kind: 'read' },
  {
    method: 'POST',
    path: '/admin/tax-rules',
    kind: 'write',
    body: { label: 'GST', rateBasisPoints: 0, appliesTo: 'FEES' },
  },
  { method: 'PATCH', path: '/admin/tax-rules/tr1', kind: 'write', body: { active: false } },
  {
    method: 'POST',
    path: '/admin/tax-rules/tr1/supersede',
    kind: 'write',
    body: { rateBasisPoints: 0, effectiveFrom: '2030-01-01' },
  },
  { method: 'DELETE', path: '/admin/tax-rules/tr1', kind: 'write' },
  { method: 'GET', path: '/admin/cinema-pricing-policies', kind: 'read' },
  { method: 'GET', path: '/admin/cinema-pricing-policies/inspect?country=IN', kind: 'read' },
  { method: 'GET', path: '/admin/cinema-pricing-policies/cp1/preflight', kind: 'read' },
  { method: 'POST', path: '/admin/cinema-pricing-policies', kind: 'write', body: {} },
  { method: 'PATCH', path: '/admin/cinema-pricing-policies/cp1', kind: 'write', body: {} },
  { method: 'POST', path: '/admin/cinema-pricing-policies/cp1/activate', kind: 'write' },
  { method: 'POST', path: '/admin/cinema-pricing-policies/cp1/supersede', kind: 'write', body: {} },
  { method: 'POST', path: '/admin/cinema-pricing-policies/cp1/disable', kind: 'write' },
  {
    method: 'POST',
    path: '/admin/ops/maintenance',
    kind: 'write',
    body: { enabled: false },
  },
];

describe('platform configuration is least-privilege', () => {
  let app: INestApplication;
  let base = '';
  /** Every stubbed service call, so a test can see what a handler did, e.g. record an audit. */
  const serviceCalls: { name: string; args: unknown[] }[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController, OpsController],
    })
      .useMocker((token) => {
        const name = typeof token === 'function' ? token.name : String(token);
        const stubs: Record<string, unknown> = {};
        return new Proxy(stubs, {
          get(target, prop) {
            if (typeof prop === 'symbol' || prop === 'then' || prop === 'constructor') {
              return undefined;
            }
            if (/^on[A-Z]|^beforeApplicationShutdown$/.test(prop)) return undefined;
            target[prop] ??= async (...args: unknown[]) => {
              serviceCalls.push({ name: `${name}.${prop}`, args });
              return { handledBy: `${name}.${prop}` };
            };
            return target[prop];
          },
        });
      })
      .compile();

    const reflector = new Reflector();
    // The grant rows the guard would read for this caller, from the same header.
    const prisma = {
      adminGrant: {
        findMany: async ({ where }: { where: { userId: string } }) => {
          const actor = ACTORS[where.userId];
          return (actor?.grants ?? []).map((permission) => ({ permission }));
        },
      },
    };
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    // Same order as AppModule: who you are, then "staff at all", then "this specific thing".
    app.useGlobalGuards(
      new HeaderUserGuard(),
      new RolesGuard(reflector),
      new AdminPermissionGuard(reflector, prisma as never),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}/api`;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  const call = async (actor: keyof typeof ACTORS, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-test-actor': JSON.stringify({ id: actor, ...ACTORS[actor] }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { handledBy?: string };
    // A stub's answer anywhere in the body proves the handler ran (readiness wraps it).
    return { status: res.status, json, ran: JSON.stringify(json).includes('"handledBy"') };
  };

  const ok = (status: number) => status >= 200 && status < 300;

  describe.each(CONFIG_ROUTES)('$method $path ($kind)', ({ method, path, kind, body }) => {
    it('refuses the support desk (BOOKING_READ only) with 403', async () => {
      const { status, ran } = await call('bookingReadOnly', method, path, body);
      expect(status).toBe(403);
      expect(ran).toBe(false);
    });

    it('refuses an account with no relevant capability', async () => {
      // OPS_READ is the capability maintenance used to inherit; it must not open a write.
      const { status } = await call('opsReader', method, path, body);
      expect(status).toBe(403);
    });

    it('lets a super admin through, by role, with no grant rows', async () => {
      const { status, ran } = await call('superAdmin', method, path, body);
      expect(ok(status)).toBe(true);
      expect(ran).toBe(true);
    });

    if (kind === 'read') {
      it('opens to PLATFORM_CONFIG_READ', async () => {
        const { status, ran } = await call('configReader', method, path, body);
        expect(ok(status)).toBe(true);
        expect(ran).toBe(true);
      });
      it('does NOT open to PLATFORM_CONFIG alone - neither capability implies the other', async () => {
        expect((await call('configEditor', method, path, body)).status).toBe(403);
      });
    } else {
      it('opens to PLATFORM_CONFIG', async () => {
        const { status, ran } = await call('configEditor', method, path, body);
        expect(ok(status)).toBe(true);
        expect(ran).toBe(true);
      });
      it('is refused to a read-only config account', async () => {
        expect((await call('configReader', method, path, body)).status).toBe(403);
      });
    }
  });

  it('gives no ready-made bundle any configuration capability', async () => {
    // Presets are what a new starter is handed in one click. None may carry, by default, the
    // power to see or change what the platform charges.
    for (const preset of Object.values(ADMIN_PRESETS)) {
      expect(preset.grants).not.toContain(AdminPermission.PLATFORM_CONFIG);
      expect(preset.grants).not.toContain(AdminPermission.PLATFORM_CONFIG_READ);
    }
  });

  it('still lets the support desk read bookings and payments (no collateral lock-out)', async () => {
    for (const path of ['/admin/bookings', '/admin/payments', '/admin/movies']) {
      const { status, json } = await call('bookingReadOnly', 'GET', path);
      expect(status).toBe(200);
      expect(json.handledBy).toBeDefined();
    }
  });

  it('records who switched maintenance mode, and records nothing for a refused attempt', async () => {
    serviceCalls.length = 0;
    expect(
      (await call('opsReader', 'POST', '/admin/ops/maintenance', { enabled: true })).status,
    ).toBe(403);
    expect(serviceCalls).toEqual([]);

    expect(
      (await call('configEditor', 'POST', '/admin/ops/maintenance', { enabled: false })).status,
    ).toBe(201);
    const audit = serviceCalls.find((c) => c.name === 'AuditService.record');
    expect(audit?.args[0]).toMatchObject({
      actorUserId: 'configEditor',
      action: 'MAINTENANCE_TOGGLED',
      metadata: { enabled: false },
    });
  });

  it('still lets an OPS_READ account see the maintenance flag', async () => {
    const { status, json } = await call('opsReader', 'GET', '/admin/ops/maintenance');
    expect(status).toBe(200);
    expect(json.handledBy).toBe('MaintenanceService.getState');
  });

  it('covers every configuration handler on AdminController - a new one cannot slip past', () => {
    /*
      A handler without its own @RequiresAdmin falls back to the class's BOOKING_READ, which is
      the defect. So every handler under a configuration path must appear in CONFIG_ROUTES above,
      where it is held to the rule over HTTP.
    */
    const CONFIG_PREFIX = /^(fee-rules|tax-rules|cinema-pricing-policies)/;
    const verbs: Record<number, string> = {
      [RequestMethod.GET]: 'GET',
      [RequestMethod.POST]: 'POST',
      [RequestMethod.PATCH]: 'PATCH',
      [RequestMethod.DELETE]: 'DELETE',
      [RequestMethod.PUT]: 'PUT',
    };
    const declared: string[] = [];
    const proto = AdminController.prototype as unknown as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(proto)) {
      const handler = proto[key];
      if (typeof handler !== 'function' || key === 'constructor') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined || !CONFIG_PREFIX.test(path)) continue;
      declared.push(`${verbs[Reflect.getMetadata(METHOD_METADATA, handler)]} ${path}`);
    }
    // Normalise the test's concrete paths back to the route templates.
    const covered = CONFIG_ROUTES.filter(
      (r) => r.path.startsWith('/admin/') && !r.path.includes('/ops/'),
    ).map(
      (r) =>
        `${r.method} ${r.path
          .replace(/^\/admin\//, '')
          .replace(/\?.*$/, '')
          .replace(/\/(fr1|tr1|cp1)(?=\/|$)/, '/:id')}`,
    );
    expect(declared.length).toBeGreaterThanOrEqual(17);
    expect([...new Set(covered)].sort()).toEqual([...new Set(declared)].sort());
  });
});
