import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NotificationsModule } from './notifications.module';

/**
 * Which controller answers each admin notification URL — over real HTTP, in the module's own
 * controller order.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * `GET /api/admin/notifications/readiness` returned 404. Nothing was wrong with the readiness
 * controller; the delivery-ops controller, listed earlier in the module, owns
 * `GET admin/notifications/:id` and caught the request first, looking up a notification whose
 * id was "readiness". Unit tests call controller methods directly and cannot see this: the
 * collision exists only in the router, and only because of the ORDER two controllers happen
 * to be listed in.
 *
 * ── HOW THIS TEST SEES IT ──────────────────────────────────────────────────────────
 * The controllers are read from `NotificationsModule`'s metadata, so the test uses whatever
 * order the module actually declares — reordering the module back reintroduces the failure
 * here. Every dependency is an automatic stub that reports which service and method it was, so
 * each response names the handler that ran. No guards are installed: they run after routing,
 * and routing is the only thing under test.
 */
describe('admin notification routes reach the right controller', () => {
  let app: INestApplication;
  let base = '';

  beforeAll(async () => {
    const controllers = Reflect.getMetadata('controllers', NotificationsModule) as never[];
    const moduleRef = await Test.createTestingModule({ controllers })
      .useMocker((token) => {
        const name = typeof token === 'function' ? token.name : String(token);
        const stubs: Record<string, unknown> = {};
        return new Proxy(stubs, {
          get(target, prop) {
            // Not a thenable, and not mistaken for a class or a lifecycle participant.
            if (typeof prop === 'symbol' || prop === 'then' || prop === 'constructor') {
              return undefined;
            }
            if (/^on[A-Z]|^beforeApplicationShutdown$/.test(prop)) return undefined;
            target[prop] ??= async () => ({ handledBy: `${name}.${prop}` });
            return target[prop];
          },
        });
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}/api`;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  const handler = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    const body = (await res.json().catch(() => ({}))) as { handledBy?: string };
    return { status: res.status, handledBy: body.handledBy };
  };

  it('GET admin/notifications/readiness is the readiness report, not notification "readiness"', async () => {
    await expect(handler('/admin/notifications/readiness')).resolves.toEqual({
      status: 200,
      handledBy: 'NotificationReadinessService.report',
    });
  });

  it.each([
    ['/admin/notifications/readiness/configuration', 'NotificationDiagnosticsService.report'],
    ['/admin/notifications/readiness/certification', 'MarketCertificationService.report'],
    ['/admin/notifications/analytics/summary', 'NotificationAnalyticsService'],
  ])('GET %s reaches its own controller', async (path, expected) => {
    const { status, handledBy } = await handler(path);
    expect(status).toBe(200);
    expect(handledBy).toMatch(new RegExp(`^${expected}`));
  });

  it('still inspects a real notification id through the ops controller', async () => {
    await expect(handler('/admin/notifications/cmabc123notification')).resolves.toEqual({
      status: 200,
      handledBy: 'NotificationOpsService.inspect',
    });
  });

  it('keeps the ops routes declared before its own :id', async () => {
    await expect(handler('/admin/notifications/health')).resolves.toMatchObject({
      handledBy: 'NotificationOpsService.providerHealth',
    });
  });
});
