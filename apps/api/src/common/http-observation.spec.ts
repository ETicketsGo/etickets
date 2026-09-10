import type { AddressInfo } from 'node:net';
import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  Module,
  NotFoundException,
  Post,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { LoggingInterceptor } from './logging.interceptor';
import { HttpObservationService } from './http-observation.service';
import { HttpObservationMiddleware } from './http-observation.middleware';
import { AppException, ErrorCodes } from './errors';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Every request is observed once — including the ones that match no route.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
 * An interceptor runs only once Nest has matched a handler. A request to a path that matches
 * nothing went straight to the global exception filter: the client got a 404, the filter wrote
 * one line, and the request log and the metrics saw nothing whatsoever. Unknown paths are
 * exactly what scanning and probing traffic looks like, so the traffic most worth counting was
 * the traffic that could not be seen. Found on QA:
 * `GET /api/definitely-not-a-route` produced an `[Exception] … -> 404` line, no `[Request]`
 * line, and no counter movement at all.
 *
 * ── AND THE ONE THING THAT MUST NOT BREAK WHILE CLOSING IT ─────────────────────────
 * Two places now ask for a request to be observed. A matched request recorded twice would
 * double every count, and a doubled error rate is exactly as untrustworthy as a hidden one.
 * Several of the tests below exist only to hold that line.
 */

@Controller()
class RoutesController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Post('unauthorized')
  unauthorized(): never {
    throw new AppException(ErrorCodes.UNAUTHORIZED, 'nope', HttpStatus.UNAUTHORIZED);
  }

  /** A 404 from a route that DOES match — the ordinary application 404. */
  @Get('items/:id')
  missing(): never {
    throw new NotFoundException('no such item');
  }

  /** Same shape as the real SES webhook, to keep the PR #92 redaction honest. */
  @Post('notifications/webhooks/ses/:secret')
  webhook(): never {
    throw new AppException(ErrorCodes.UNAUTHORIZED, 'nope', HttpStatus.UNAUTHORIZED);
  }
}

const observed: { method: string; status: number; seconds: number }[] = [];

@Module({
  controllers: [RoutesController],
  providers: [
    {
      provide: MetricsService,
      useValue: {
        observeHttp: (method: string, status: number, seconds: number) =>
          void observed.push({ method, status, seconds }),
      },
    },
    HttpObservationService,
    HttpObservationMiddleware,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // The same binding AppModule uses.
    consumer.apply(HttpObservationMiddleware).forRoutes('{*path}');
  }
}

describe('HTTP observation covers matched and unmatched routes alike', () => {
  let app: INestApplication;
  let base: string;
  let logged: string[];
  let spies: jest.SpyInstance[];

  beforeEach(async () => {
    observed.length = 0;
    logged = [];
    spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );

    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    if (app) await app.close();
    spies.forEach((s) => s.mockRestore());
  });

  const requestLines = () => logged.filter((l) => l.includes('"msg":"request"'));
  const requestLog = () => {
    const lines = requestLines();
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0].slice(lines[0].indexOf('{'))) as Record<string, unknown>;
  };

  it('records an unmatched route as a 404', async () => {
    // The gap. Before the middleware existed this produced nothing at all.
    const res = await fetch(`${base}/definitely-not-a-route`);
    expect(res.status).toBe(404);

    expect(observed).toEqual([{ method: 'GET', status: 404, seconds: expect.any(Number) }]);
    expect(requestLog()).toMatchObject({
      method: 'GET',
      path: '/api/definitely-not-a-route',
      status: 404,
    });
  });

  it('records an unmatched route on a non-GET method too', async () => {
    const res = await fetch(`${base}/nope/not/here`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ method: 'POST', status: 404 });
  });

  it('records a 404 thrown by a route that DID match', async () => {
    // A different code path from the one above: this reaches a handler, which throws.
    const res = await fetch(`${base}/items/does-not-exist`);
    expect(res.status).toBe(404);
    expect(observed).toEqual([{ method: 'GET', status: 404, seconds: expect.any(Number) }]);
    expect(requestLog()).toMatchObject({ path: '/api/items/does-not-exist', status: 404 });
  });

  it('records a 401 from a matched handler', async () => {
    const res = await fetch(`${base}/unauthorized`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(observed).toEqual([{ method: 'POST', status: 401, seconds: expect.any(Number) }]);
    expect(requestLog().status).toBe(401);
  });

  it('records a 200 from a matched handler', async () => {
    const res = await fetch(`${base}/ok`);
    expect(res.status).toBe(200);
    expect(observed).toEqual([{ method: 'GET', status: 200, seconds: expect.any(Number) }]);
    expect(requestLog().status).toBe(200);
  });

  /*
    ── THE DUPLICATE-PREVENTION TESTS ──────────────────────────────────────────────────
    Both the middleware and the interceptor arm observation for a matched request. If the
    latch in HttpObservationService ever stopped working, every matched route would count
    twice while unmatched routes counted once — a skew that would look like a traffic pattern
    rather than a bug.
  */
  it('records a matched request exactly once, though two places arm it', async () => {
    await fetch(`${base}/ok`);
    expect(observed).toHaveLength(1);
    expect(requestLines()).toHaveLength(1);
  });

  it('records a matched ERROR request exactly once', async () => {
    await fetch(`${base}/unauthorized`, { method: 'POST' });
    expect(observed).toHaveLength(1);
    expect(requestLines()).toHaveLength(1);
  });

  it('records an unmatched request exactly once', async () => {
    await fetch(`${base}/definitely-not-a-route`);
    expect(observed).toHaveLength(1);
    expect(requestLines()).toHaveLength(1);
  });

  it('counts a mixed run once per request and no more', async () => {
    await fetch(`${base}/ok`);
    await fetch(`${base}/unauthorized`, { method: 'POST' });
    await fetch(`${base}/definitely-not-a-route`);
    await fetch(`${base}/items/x`);
    expect(observed).toHaveLength(4);
    expect(requestLines()).toHaveLength(4);
    expect(observed.map((o) => o.status).sort()).toEqual([200, 401, 404, 404]);
  });

  it('still redacts the webhook secret, on a route reached through the middleware', async () => {
    const secret = 'k9Vx2pQ7-Rj4LmN8sT1wY6bZ0cH3dF5gA';
    const res = await fetch(`${base}/notifications/webhooks/ses/${secret}`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(logged.join('\n')).not.toContain(secret);
    expect(requestLog().path).toBe('/api/notifications/webhooks/ses/[REDACTED]');
  });

  it('redacts an unmatched path under the webhook route too', async () => {
    /*
      A stranger probing `/notifications/webhooks/ses/<guess>` with a wrong method matches no
      route — so this is now logged, and the guess must not be logged with it. A path that is
      only observed because it matched nothing is still a path that can carry a credential.
    */
    const secret = 'some-guessed-value-that-must-not-be-logged';
    const res = await fetch(`${base}/notifications/webhooks/ses/${secret}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(logged.join('\n')).not.toContain(secret);
    expect(requestLog().path).toBe('/api/notifications/webhooks/ses/[REDACTED]');
  });

  it('keeps probes out of the log while still counting them', async () => {
    // Unmatched in this test module, but the path rule is what decides — and the metric is
    // still recorded, so a probe outage is visible even though the line is not written.
    await fetch(`${base}/health`);
    expect(requestLines()).toHaveLength(0);
    expect(observed).toHaveLength(1);
  });
});
