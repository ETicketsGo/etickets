import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  type Provider,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ADMIN_PRESETS, ALL_ADMIN_PERMISSIONS, AdminPermission } from '@eticketsgo/shared-types';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ADMIN_PERMISSION_KEY } from '../common/decorators';
import { OpsController } from '../ops/ops.controller';
import { OutboxOpsController } from '../common/domain-events/outbox/outbox-ops.controller';
import { OutboxOpsService } from '../common/domain-events/outbox/outbox-ops.service';
import { SyncOpsController } from '../inventory/sync/sync-ops.controller';
import { SyncOpsService } from '../inventory/sync/sync-ops.service';
import { INVENTORY_SYNC_QUEUE } from '../inventory/sync/sync-queue.provider';
import { CompensationAdminController } from '../bookings/compensation/compensation-admin.controller';
import { FinanceReconciliationController } from '../payments/finance/finance-reconciliation.controller';
import { AdminSupportController } from '../support/support.controller';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MetricsService } from '../metrics/metrics.service';
import { OutboxDispatcher } from '../common/domain-events/outbox/outbox-dispatcher.service';
import { SyncCheckpointService } from '../inventory/sync/sync-checkpoint.service';

/**
 * Seeing a queue is not acting on it - over real HTTP, through the real guards.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * Six admin controllers put a READ capability on the class and declared nothing on their
 * mutating handlers, and `AdminPermissionGuard` resolves handler-then-class. So:
 *   - OPS_READ ("see queue depth") could retry every failed job, replay / cancel / park outbox
 *     events, and reprocess, re-map or reset the checkpoint of an inventory sync;
 *   - FINANCE_READ ("see revenue") could approve, retry and release a booking compensation, run
 *     discrepancy detection, and resolve or ignore a money discrepancy;
 *   - BOOKING_READ (the support desk's floor) could change the status of a complaint.
 * Each write now needs its own capability (OPS_EXECUTE, FINANCE_APPROVE, FINANCE_RESOLVE,
 * SUPPORT_MANAGE). Those are granted to nobody: no preset, no migration.
 *
 * ── HOW THIS TEST SEES IT ──────────────────────────────────────────────────────────
 * As `admin-config-authz.spec.ts`: the real `RolesGuard` and `AdminPermissionGuard` run against
 * the real controllers. Only the caller (a header standing in for the JWT), the grant rows and
 * the services are stubbed, and every stub names itself, so a 2xx proves the handler ran and an
 * empty call log proves a refused call did nothing.
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

const NEW_ACTION_CAPABILITIES: AdminPermission[] = [
  AdminPermission.OPS_EXECUTE,
  AdminPermission.FINANCE_APPROVE,
  AdminPermission.FINANCE_RESOLVE,
  AdminPermission.SUPPORT_MANAGE,
];

/** Every capability that existed before this change. None of them may open an action below. */
const EVERY_OLD_CAPABILITY = ALL_ADMIN_PERMISSIONS.filter(
  (p) => !NEW_ACTION_CAPABILITIES.includes(p),
);

const ACTORS: Record<string, Actor> = {
  opsReader: { roles: ['ADMIN'], grants: [AdminPermission.OPS_READ] },
  financeReader: { roles: ['ADMIN'], grants: [AdminPermission.FINANCE_READ] },
  /**
   * The SUPPORT preset as it was when these actions were split out of the reads - what an
   * existing support account still holds, because editing a preset changes no account.
   */
  supportDesk: {
    roles: ['ADMIN'],
    grants: [AdminPermission.BOOKING_READ, AdminPermission.ORGANIZER_READ],
  },
  /** The FINANCE preset as it was then - the account most of the finance routes were used by. */
  financePreset: {
    roles: ['ADMIN'],
    grants: [
      AdminPermission.BOOKING_READ,
      AdminPermission.FINANCE_READ,
      AdminPermission.REFUND_REVIEW,
      AdminPermission.REFUND_APPROVE,
      AdminPermission.PAYOUT_MANAGE,
    ],
  },
  /** Every capability in the catalogue before this change, including ADMIN_MANAGE. */
  everyOldCapability: { roles: ['ADMIN'], grants: EVERY_OLD_CAPABILITY },
  opsExecutor: { roles: ['ADMIN'], grants: [AdminPermission.OPS_EXECUTE] },
  financeApprover: { roles: ['ADMIN'], grants: [AdminPermission.FINANCE_APPROVE] },
  financeResolver: { roles: ['ADMIN'], grants: [AdminPermission.FINANCE_RESOLVE] },
  supportManager: { roles: ['ADMIN'], grants: [AdminPermission.SUPPORT_MANAGE] },
  /** Holds everything by role, with no grant rows at all. */
  superAdmin: { roles: ['ADMIN', 'SUPER_ADMIN'], grants: [] },
};

/** Which test actor holds exactly the capability a route needs. */
const HOLDER: Record<string, keyof typeof ACTORS> = {
  [AdminPermission.OPS_EXECUTE]: 'opsExecutor',
  [AdminPermission.FINANCE_APPROVE]: 'financeApprover',
  [AdminPermission.FINANCE_RESOLVE]: 'financeResolver',
  [AdminPermission.SUPPORT_MANAGE]: 'supportManager',
};

/** The read actor whose capability the route used to inherit. */
const READER: Record<string, keyof typeof ACTORS> = {
  [AdminPermission.OPS_READ]: 'opsReader',
  [AdminPermission.FINANCE_READ]: 'financeReader',
  [AdminPermission.BOOKING_READ]: 'supportDesk',
};

type ActionRoute = {
  method: 'POST' | 'PATCH';
  /** A concrete path the route answers. */
  path: string;
  /** The controller's route template, `METHOD path`, for the coverage check. */
  template: string;
  /** The capability it used to inherit from its class. */
  inherited: AdminPermission;
  needs: AdminPermission;
  body?: unknown;
  /**
   * Whether the handler hands the caller's id to the service, which is what the service's audit
   * row records as the actor. False only where the service records no audit row today (the
   * matrix lists these as a follow-up; this change does not alter handler logic).
   */
  forwardsActor: boolean;
};

/*
  Every write on the six controllers, with a body each route's validation accepts - so an allowed
  call reaches the handler and answers 2xx rather than stopping at a 400 that proves nothing.
*/
const ACTION_ROUTES: ActionRoute[] = [
  // OpsController (class OPS_READ)
  {
    method: 'POST',
    path: '/admin/ops/queues/retry-failed',
    template: 'POST admin/ops/queues/retry-failed',
    inherited: AdminPermission.OPS_READ,
    needs: AdminPermission.OPS_EXECUTE,
    forwardsActor: false,
  },
  {
    method: 'POST',
    path: '/admin/ops/queues/jobs/j1/retry',
    template: 'POST admin/ops/queues/jobs/:id/retry',
    inherited: AdminPermission.OPS_READ,
    needs: AdminPermission.OPS_EXECUTE,
    forwardsActor: false,
  },
  // OutboxOpsController (class OPS_READ)
  ...(
    [
      ['/admin/outbox/events/o1/retry', 'POST admin/outbox/events/:id/retry'],
      ['/admin/outbox/retry-batch?status=DEAD_LETTERED', 'POST admin/outbox/retry-batch'],
      ['/admin/outbox/events/o1/cancel', 'POST admin/outbox/events/:id/cancel'],
      ['/admin/outbox/events/o1/manual-review', 'POST admin/outbox/events/:id/manual-review'],
      ['/admin/outbox/recover-stale-leases', 'POST admin/outbox/recover-stale-leases'],
    ] as const
  ).map(([path, template]): ActionRoute => ({
    method: 'POST',
    path,
    template,
    inherited: AdminPermission.OPS_READ,
    needs: AdminPermission.OPS_EXECUTE,
    body: {},
    forwardsActor: true,
  })),
  // SyncOpsController (class OPS_READ)
  ...(
    [
      ['/admin/inventory-sync/events/r1/reprocess', 'events/:id/reprocess', undefined, true],
      [
        '/admin/inventory-sync/events/r1/manual-review',
        'events/:id/manual-review',
        undefined,
        true,
      ],
      [
        '/admin/inventory-sync/providers/p1/retry-failed',
        'providers/:providerCode/retry-failed',
        undefined,
        true,
      ],
      [
        '/admin/inventory-sync/providers/p1/reconcile',
        'providers/:providerCode/reconcile',
        undefined,
        false,
      ],
      [
        '/admin/inventory-sync/mappings/m1/resolve',
        'mappings/:id/resolve',
        { internalEntityType: 'cinema', internalEntityId: 'c1' },
        true,
      ],
      [
        '/admin/inventory-sync/providers/p1/checkpoint/reset',
        'providers/:providerCode/checkpoint/reset',
        { resource: 'shows' },
        true,
      ],
    ] as const
  ).map(([path, template, body, forwardsActor]): ActionRoute => ({
    method: 'POST',
    path,
    template: `POST admin/inventory-sync/${template}`,
    inherited: AdminPermission.OPS_READ,
    needs: AdminPermission.OPS_EXECUTE,
    body,
    forwardsActor,
  })),
  // CompensationAdminController (class FINANCE_READ)
  {
    method: 'POST',
    path: '/admin/compensations/c1/approve',
    template: 'POST admin/compensations/:id/approve',
    inherited: AdminPermission.FINANCE_READ,
    needs: AdminPermission.FINANCE_APPROVE,
    forwardsActor: true,
  },
  {
    method: 'POST',
    path: '/admin/compensations/c1/retry',
    template: 'POST admin/compensations/:id/retry',
    inherited: AdminPermission.FINANCE_READ,
    needs: AdminPermission.FINANCE_APPROVE,
    forwardsActor: true,
  },
  {
    method: 'POST',
    path: '/admin/compensations/c1/release-lease',
    template: 'POST admin/compensations/:id/release-lease',
    inherited: AdminPermission.FINANCE_READ,
    needs: AdminPermission.FINANCE_APPROVE,
    forwardsActor: true,
  },
  {
    method: 'POST',
    path: '/admin/compensations/c1/manual-review',
    template: 'POST admin/compensations/:id/manual-review',
    inherited: AdminPermission.FINANCE_READ,
    needs: AdminPermission.FINANCE_RESOLVE,
    body: { reason: 'looks wrong' },
    forwardsActor: true,
  },
  // FinanceReconciliationController (class FINANCE_READ)
  {
    method: 'POST',
    path: '/admin/payments/finance/detect',
    template: 'POST admin/payments/finance/detect',
    inherited: AdminPermission.FINANCE_READ,
    needs: AdminPermission.FINANCE_RESOLVE,
    // Detection files rows and records its own audit row with no actor (unchanged).
    forwardsActor: false,
  },
  {
    method: 'POST',
    path: '/admin/payments/finance/discrepancies/d1/assign',
    template: 'POST admin/payments/finance/discrepancies/:id/assign',
    inherited: AdminPermission.FINANCE_READ,
    needs: AdminPermission.FINANCE_RESOLVE,
    body: { userId: 'u1' },
    forwardsActor: true,
  },
  {
    method: 'POST',
    path: '/admin/payments/finance/discrepancies/d1/resolve',
    template: 'POST admin/payments/finance/discrepancies/:id/resolve',
    inherited: AdminPermission.FINANCE_READ,
    needs: AdminPermission.FINANCE_RESOLVE,
    body: { notes: 'matched by hand' },
    forwardsActor: true,
  },
  {
    method: 'POST',
    path: '/admin/payments/finance/discrepancies/d1/ignore',
    template: 'POST admin/payments/finance/discrepancies/:id/ignore',
    inherited: AdminPermission.FINANCE_READ,
    needs: AdminPermission.FINANCE_RESOLVE,
    body: { notes: 'test transaction' },
    forwardsActor: true,
  },
  // AdminSupportController (class BOOKING_READ)
  {
    method: 'PATCH',
    path: '/admin/support/s1',
    template: 'PATCH admin/support/:id',
    inherited: AdminPermission.BOOKING_READ,
    needs: AdminPermission.SUPPORT_MANAGE,
    body: { status: 'CLOSED' },
    forwardsActor: false,
  },
];

/** The reads on the same controllers, which must stay open to the read capability. */
const READ_ROUTES: { path: string; needs: AdminPermission }[] = [
  { path: '/admin/ops/queues', needs: AdminPermission.OPS_READ },
  { path: '/admin/ops/queues/failed', needs: AdminPermission.OPS_READ },
  { path: '/admin/outbox/health', needs: AdminPermission.OPS_READ },
  { path: '/admin/outbox/events?status=DEAD_LETTERED', needs: AdminPermission.OPS_READ },
  { path: '/admin/outbox/events/o1', needs: AdminPermission.OPS_READ },
  { path: '/admin/inventory-sync/providers/p1/health', needs: AdminPermission.OPS_READ },
  { path: '/admin/inventory-sync/mappings', needs: AdminPermission.OPS_READ },
  { path: '/admin/compensations', needs: AdminPermission.FINANCE_READ },
  { path: '/admin/compensations/c1', needs: AdminPermission.FINANCE_READ },
  { path: '/admin/payments/finance/discrepancies', needs: AdminPermission.FINANCE_READ },
  { path: '/admin/payments/finance/aging', needs: AdminPermission.FINANCE_READ },
  { path: '/admin/support', needs: AdminPermission.BOOKING_READ },
];

/** A POST that persists nothing and so stays on the read capability, on purpose. */
const READ_ONLY_POSTS = ['POST admin/compensations/dry-run'];

/** Writes on these controllers held over HTTP by another spec (admin-config-authz.spec.ts). */
const COVERED_ELSEWHERE = ['POST admin/ops/maintenance'];

const CONTROLLERS: Type[] = [
  OpsController,
  OutboxOpsController,
  SyncOpsController,
  CompensationAdminController,
  FinanceReconciliationController,
  AdminSupportController,
];

const READ_CAPABILITIES = new Set<string>([
  AdminPermission.BOOKING_READ,
  AdminPermission.ORGANIZER_READ,
  AdminPermission.FINANCE_READ,
  AdminPermission.OPS_READ,
  AdminPermission.PLATFORM_CONFIG_READ,
]);

/** Each automatic service stub's calls, so a test can see what a handler did. */
const serviceCalls: { name: string; args: unknown[] }[] = [];

function namedStub(token: unknown) {
  const name = typeof token === 'function' ? token.name : String(token);
  const stubs: Record<string, unknown> = {};
  return new Proxy(stubs, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'constructor') return undefined;
      if (/^on[A-Z]|^beforeApplicationShutdown$/.test(prop)) return undefined;
      target[prop] ??= async (...args: unknown[]) => {
        serviceCalls.push({ name: `${name}.${prop}`, args });
        return { handledBy: `${name}.${prop}` };
      };
      return target[prop];
    },
  });
}

/** Build an app with the real guards in AppModule's order. */
async function boot(controllers: Type[], providers: Provider[] = []) {
  // Anything not provided explicitly is an automatic, self-naming stub.
  const moduleRef = await Test.createTestingModule({ controllers, providers })
    .useMocker(namedStub)
    .compile();
  const reflector = new Reflector();
  const prisma = {
    adminGrant: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        (ACTORS[where.userId]?.grants ?? []).map((permission) => ({ permission })),
    },
  };
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalGuards(
    new HeaderUserGuard(),
    new RolesGuard(reflector),
    new AdminPermissionGuard(reflector, prisma as never),
  );
  await app.init();
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}/api` };
}

async function call(
  base: string,
  actor: keyof typeof ACTORS,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-test-actor': JSON.stringify({ id: actor, ...ACTORS[actor] }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  return { status: res.status, json, ran: JSON.stringify(json).includes('"handledBy"') };
}

const ok = (status: number) => status >= 200 && status < 300;

describe('acting on an admin queue needs more than seeing it', () => {
  let app: INestApplication;
  let base = '';

  beforeAll(async () => {
    ({ app, base } = await boot(CONTROLLERS));
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  describe.each(ACTION_ROUTES)('$method $path', (route) => {
    const { method, path, body, inherited, needs } = route;

    it(`refuses the ${inherited} holder it used to let through, and runs nothing`, async () => {
      serviceCalls.length = 0;
      const { status, ran } = await call(base, READER[inherited], method, path, body);
      expect(status).toBe(403);
      expect(ran).toBe(false);
      expect(serviceCalls).toEqual([]);
    });

    it('refuses every capability that existed before this change, ADMIN_MANAGE included', async () => {
      serviceCalls.length = 0;
      const { status } = await call(base, 'everyOldCapability', method, path, body);
      expect(status).toBe(403);
      expect(serviceCalls).toEqual([]);
    });

    it('refuses accounts holding the FINANCE and SUPPORT bundles as they were before approval', async () => {
      expect((await call(base, 'financePreset', method, path, body)).status).toBe(403);
      expect((await call(base, 'supportDesk', method, path, body)).status).toBe(403);
    });

    it('opens to a ready-made bundle exactly when the bundle carries its capability', async () => {
      // The owner-approved presets: FINANCE carries FINANCE_APPROVE and FINANCE_RESOLVE,
      // SUPPORT carries SUPPORT_MANAGE, OPERATIONS carries OPS_EXECUTE, REFUND_DESK none.
      for (const [key, preset] of Object.entries(ADMIN_PRESETS)) {
        const actor = `preset:${key}`;
        ACTORS[actor] = { roles: ['ADMIN'], grants: [...preset.grants] };
        const { status } = await call(base, actor, method, path, body);
        expect({ preset: key, allowed: ok(status) }).toEqual({
          preset: key,
          allowed: preset.grants.includes(needs),
        });
      }
    });

    it(`opens to ${needs}`, async () => {
      serviceCalls.length = 0;
      const { status, ran } = await call(base, HOLDER[needs], method, path, body);
      expect(ok(status)).toBe(true);
      expect(ran).toBe(true);
      if (route.forwardsActor) {
        // The service records its audit row with this id as the actor.
        expect(JSON.stringify(serviceCalls.map((c) => c.args))).toContain(`"${HOLDER[needs]}"`);
      }
    });

    it('does not open to a different new action capability', async () => {
      for (const other of NEW_ACTION_CAPABILITIES.filter((c) => c !== needs)) {
        expect((await call(base, HOLDER[other], method, path, body)).status).toBe(403);
      }
    });

    it('lets a super admin through, by role, with no grant rows', async () => {
      const { status, ran } = await call(base, 'superAdmin', method, path, body);
      expect(ok(status)).toBe(true);
      expect(ran).toBe(true);
    });
  });

  describe.each(READ_ROUTES)('GET $path', ({ path, needs }) => {
    it(`stays open to ${needs} (no collateral lock-out)`, async () => {
      const { status, ran } = await call(base, READER[needs], 'GET', path);
      expect(status).toBe(200);
      expect(ran).toBe(true);
    });

    it('does not open to an action capability alone - neither implies the other', async () => {
      for (const action of NEW_ACTION_CAPABILITIES) {
        expect((await call(base, HOLDER[action], 'GET', path)).status).toBe(403);
      }
    });
  });

  it('keeps the compensation dry run (persists nothing) on FINANCE_READ', async () => {
    const { status, ran } = await call(
      base,
      'financeReader',
      'POST',
      '/admin/compensations/dry-run',
      {
        bookingId: 'b1',
      },
    );
    expect(status).toBe(201);
    expect(ran).toBe(true);
  });

  it('grants the action capabilities only to the bundles the owner approved', () => {
    const carriers = Object.fromEntries(
      NEW_ACTION_CAPABILITIES.map((action) => [
        action,
        Object.entries(ADMIN_PRESETS)
          .filter(([, p]) => p.grants.includes(action))
          .map(([key]) => key)
          .sort(),
      ]),
    );
    expect(carriers).toEqual({
      [AdminPermission.OPS_EXECUTE]: ['OPERATIONS'],
      [AdminPermission.FINANCE_APPROVE]: ['FINANCE'],
      [AdminPermission.FINANCE_RESOLVE]: ['FINANCE'],
      // Not REFUND_DESK: the owner kept it out.
      [AdminPermission.SUPPORT_MANAGE]: ['SUPPORT'],
    });
  });

  it('covers every write on these controllers, and none of them rests on a read capability', () => {
    /*
      A new POST on one of these controllers would inherit the class's READ capability - the
      defect this file is about. So every mutating handler must (a) declare its own
      @RequiresAdmin, (b) name no read capability there, and (c) appear in ACTION_ROUTES above,
      where it is held to the rule over HTTP.
    */
    const verbs: Record<number, string> = {
      [RequestMethod.POST]: 'POST',
      [RequestMethod.PATCH]: 'PATCH',
      [RequestMethod.PUT]: 'PUT',
      [RequestMethod.DELETE]: 'DELETE',
    };
    const declared: string[] = [];
    const leaning: string[] = [];
    for (const controller of CONTROLLERS) {
      const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
      const proto = controller.prototype as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(proto)) {
        const handler = proto[key];
        if (typeof handler !== 'function' || key === 'constructor') continue;
        const verb = verbs[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (!verb || path === undefined) continue;
        const route = `${verb} ${[base, path].filter((s) => s && s !== '/').join('/')}`;
        if (READ_ONLY_POSTS.includes(route)) continue;
        if (!COVERED_ELSEWHERE.includes(route)) declared.push(route);
        const own = Reflect.getMetadata(ADMIN_PERMISSION_KEY, handler) as string[] | undefined;
        if (!own || own.length === 0 || own.some((p) => READ_CAPABILITIES.has(p))) {
          leaning.push(`${controller.name}.${key}`);
        }
      }
    }
    expect(declared.length).toBe(ACTION_ROUTES.length);
    expect(leaning).toEqual([]);
    expect([...declared].sort()).toEqual(ACTION_ROUTES.map((r) => r.template).sort());
  });
});

/**
 * The audit trail survives the re-guarding: through the same guards, but with the REAL outbox
 * and sync operation services (only their database, queue and metrics stubbed), an allowed call
 * records its audit row with the caller as actor, and a refused one records nothing at all.
 * Compensation and discrepancy audit rows are held by their own service specs
 * (compensation-admin.service.spec.ts, finance-reconciliation.spec.ts); this change touches no
 * service.
 */
describe('allowed operations keep their audit rows; refused ones write nothing', () => {
  let app: INestApplication;
  let base = '';
  const audits: { actorUserId: string | null; action: string }[] = [];
  const writes: string[] = [];

  beforeAll(async () => {
    const write = (name: string, result: unknown) => async () => {
      writes.push(name);
      return result;
    };
    const prisma = {
      outboxEvent: {
        updateMany: write('outboxEvent.updateMany', { count: 1 }),
        update: write('outboxEvent.update', {}),
        findMany: async () => [{ id: 'o1' }],
      },
      rawProviderEvent: {
        findUnique: async () => ({ providerCode: 'p1' }),
        findMany: async () => [{ id: 'r1' }],
        update: write('rawProviderEvent.update', {}),
      },
      providerMapping: { update: write('providerMapping.update', {}) },
      cinema: { findUnique: async () => ({ id: 'c1' }) },
    };
    ({ app, base } = await boot(
      [OutboxOpsController, SyncOpsController],
      [
        // The real services: what they audit is what this block is about.
        OutboxOpsService,
        SyncOpsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: AuditService,
          useValue: {
            record: async (row: { actorUserId: string | null; action: string }) => {
              audits.push({ actorUserId: row.actorUserId, action: row.action });
            },
          },
        },
        { provide: MetricsService, useValue: { recordOutboxOp: () => undefined } },
        { provide: OutboxDispatcher, useValue: { recoverStaleLeases: async () => 0 } },
        {
          provide: SyncCheckpointService,
          useValue: { advance: write('checkpoint.advance', undefined) },
        },
        {
          provide: INVENTORY_SYNC_QUEUE,
          useValue: { add: write('queue.add', undefined), close: async () => undefined },
        },
      ],
    ));
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  const AUDITED: [string, unknown, string][] = [
    ['/admin/outbox/events/o1/retry', {}, 'OUTBOX_RETRY'],
    ['/admin/outbox/retry-batch?status=DEAD_LETTERED', {}, 'OUTBOX_RETRY_BATCH'],
    ['/admin/outbox/events/o1/cancel', {}, 'OUTBOX_CANCEL'],
    ['/admin/outbox/events/o1/manual-review', {}, 'OUTBOX_MANUAL_REVIEW'],
    ['/admin/outbox/recover-stale-leases', {}, 'OUTBOX_STALE_RECOVERY'],
    ['/admin/inventory-sync/events/r1/reprocess', undefined, 'SYNC_EVENT_REPROCESS'],
    ['/admin/inventory-sync/events/r1/manual-review', undefined, 'SYNC_EVENT_MANUAL_REVIEW'],
    ['/admin/inventory-sync/providers/p1/retry-failed', undefined, 'SYNC_RETRY_FAILED'],
    [
      '/admin/inventory-sync/mappings/m1/resolve',
      { internalEntityType: 'cinema', internalEntityId: 'c1' },
      'SYNC_MAPPING_RESOLVE',
    ],
    [
      '/admin/inventory-sync/providers/p1/checkpoint/reset',
      { resource: 'shows' },
      'SYNC_CHECKPOINT_RESET',
    ],
  ];

  it.each(AUDITED)('POST %s', async (path, body, action) => {
    audits.length = 0;
    writes.length = 0;
    // Refused: the read-only operator changes nothing and leaves no trace.
    expect((await call(base, 'opsReader', 'POST', path, body)).status).toBe(403);
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);

    // Allowed: the same call by the holder of OPS_EXECUTE is recorded against them.
    expect((await call(base, 'opsExecutor', 'POST', path, body)).status).toBe(201);
    expect(audits).toEqual([{ actorUserId: 'opsExecutor', action }]);
  });
});
