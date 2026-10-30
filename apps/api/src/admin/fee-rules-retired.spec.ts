import type { AddressInfo } from 'node:net';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AdminPermission, FeeMode } from '@eticketsgo/shared-types';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { PricingService } from '../pricing/pricing.service';
import {
  AdminController,
  SINGLE_BAND_FEE_DEPRECATED_AT,
  SINGLE_BAND_FEE_SUNSET,
} from './admin.controller';

/**
 * The single-band fee writes (POST/PATCH/DELETE /admin/fee-rules) are retired.
 *
 * They edited one band in place: no whole-schedule check, no per-currency publish lock, no
 * schedule version bump, no publish audit. Nothing calls them any more, so they now refuse
 * with 410 and touch nothing; fee bands change only through /admin/fee-schedules.
 */

/** @nestjs/swagger's metadata key for @ApiOperation (its constants file is not a public export). */
const API_OPERATION = 'swagger/apiOperation';

type Actor = { roles: string[]; grants: string[] };
const ACTORS: Record<string, Actor> = {
  configEditor: { roles: ['ADMIN'], grants: [AdminPermission.PLATFORM_CONFIG] },
  configReader: { roles: ['ADMIN'], grants: [AdminPermission.PLATFORM_CONFIG_READ] },
};

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

const WRITES = [
  {
    method: 'POST',
    path: '/admin/fee-rules',
    body: { currency: 'INR', minMinor: 0, maxMinor: null, feeMinor: 1 },
  },
  { method: 'PATCH', path: '/admin/fee-rules/fr1', body: { feeMinor: 999 } },
  { method: 'DELETE', path: '/admin/fee-rules/fr1' },
] as const;

describe('retired single-band fee writes', () => {
  let app: INestApplication;
  let base = '';
  const serviceCalls: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [AdminController] })
      .useMocker((token) => {
        const name = typeof token === 'function' ? token.name : String(token);
        return new Proxy({} as Record<string, unknown>, {
          get(target, prop) {
            if (typeof prop === 'symbol' || prop === 'then' || prop === 'constructor') {
              return undefined;
            }
            if (/^on[A-Z]|^beforeApplicationShutdown$/.test(prop)) return undefined;
            target[prop] ??= async () => {
              serviceCalls.push(`${name}.${prop}`);
              return { handledBy: `${name}.${prop}` };
            };
            return target[prop];
          },
        });
      })
      .compile();
    const reflector = new Reflector();
    const prisma = {
      adminGrant: {
        findMany: async ({ where }: { where: { userId: string } }) =>
          (ACTORS[where.userId]?.grants ?? []).map((permission) => ({ permission })),
      },
    };
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
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

  const call = (actor: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-test-actor': JSON.stringify({ id: actor, ...ACTORS[actor] }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  describe.each(WRITES)('$method $path', ({ method, path, ...rest }) => {
    const body = 'body' in rest ? rest.body : undefined;

    it('refuses an allowed caller with 410, points to fee schedules, and reaches no service', async () => {
      serviceCalls.length = 0;
      const res = await call('configEditor', method, path, body);
      expect(res.status).toBe(410);
      expect(res.headers.get('deprecation')).toBe(SINGLE_BAND_FEE_DEPRECATED_AT);
      expect(res.headers.get('sunset')).toBe(SINGLE_BAND_FEE_SUNSET);
      expect(res.headers.get('link')).toContain('/api/admin/fee-schedules');
      const json = (await res.json()) as { code: string; details: { replacement: string } };
      expect(json.code).toBe('FEE_RULE_ENDPOINT_GONE');
      expect(json.details.replacement).toBe('/api/admin/fee-schedules');
      // No AdminService, FeeSchedulesService, Prisma or audit call: nothing was read or written.
      expect(serviceCalls).toEqual([]);
    });

    it('is still closed to a caller who could not publish (403 before the 410)', async () => {
      expect((await call('configReader', method, path, body)).status).toBe(403);
    });
  });

  it('is marked deprecated in the API docs', () => {
    for (const key of ['createFeeRule', 'updateFeeRule', 'deleteFeeRule'] as const) {
      const op = Reflect.getMetadata(API_OPERATION, AdminController.prototype[key]) as {
        deprecated?: boolean;
      };
      expect(op.deprecated).toBe(true);
    }
  });

  it('cannot change live pricing: a refused PATCH leaves the fee and the quote version alone', async () => {
    const bands = [
      {
        id: 'fr1',
        minMinor: 0,
        maxMinor: null,
        feeMinor: 500,
        feeType: 'FLAT',
        country: 'India',
        region: '*',
        active: true,
      },
    ];
    const pricing = new PricingService(
      { feeRule: { findMany: jest.fn(async () => bands.map((b) => ({ ...b }))) } } as never,
      {
        quote: jest.fn().mockResolvedValue({ taxLines: [], taxMinor: 0, taxAddedMinor: 0 }),
      } as never,
      { get: () => undefined } as never,
      { resolve: jest.fn().mockResolvedValue(null) } as never,
    );
    const quote = () =>
      pricing.quote(10_000, FeeMode.CUSTOMER_PAYS, 0, 'INR', { country: 'India' });

    const before = await quote();
    expect(
      (await call('configEditor', 'PATCH', '/admin/fee-rules/fr1', { feeMinor: 999 })).status,
    ).toBe(410);
    const after = await quote();
    expect(after.bookingFeeMinor).toBe(before.bookingFeeMinor);
    expect(after.feeScheduleVersion).toBe(before.feeScheduleVersion);

    // And if a band were ever changed in place again (the old route's effect), the quote
    // version still moves, so a booking made from an older quote is refused.
    bands[0].feeMinor = 999;
    expect((await quote()).feeScheduleVersion).not.toBe(before.feeScheduleVersion);
  });
});
