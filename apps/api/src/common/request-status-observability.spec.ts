import type { AddressInfo } from 'node:net';
import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  Module,
  NotFoundException,
  Post,
  Res,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Response } from 'express';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { LoggingInterceptor } from './logging.interceptor';
import { HttpObservationService } from './http-observation.service';
import { AppException, ErrorCodes } from './errors';
import { MetricsService } from '../metrics/metrics.service';

/**
 * The status we record is the status the client received.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * The interceptor recorded from an RxJS `tap({ next, error })`. On the error path the tap
 * fires BEFORE Nest hands the exception to the filter that decides the status and writes the
 * response, so it read Express's default — 200 for GET, 201 for POST — and every failed
 * request was recorded as a success. The same value fed `observeHttp`, so the Prometheus
 * counters agreed with it.
 *
 * Proven on QA: three requests that returned 401 to the client produced
 * `etg_http_requests_total{method="POST",status_class="2xx"} 3`, with no 4xx series at all.
 *
 * ── WHY THESE TESTS SPEAK HTTP ─────────────────────────────────────────────────────
 * The bug lived in the gap between the handler erroring and the response being written. Only
 * a real request crosses that gap: a unit test that called `record()` directly would assert
 * on whatever status it passed in, which is the one thing that was never in question.
 */

@Controller()
class StatusController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Post('created')
  created() {
    return { created: true };
  }

  @Get('moved')
  moved(@Res() res: Response) {
    // A status set on the response directly rather than thrown — the interceptor must read
    // what was actually written, not what the framework would have defaulted to.
    res.status(HttpStatus.FOUND).json({ moved: true });
  }

  @Post('bad-request')
  badRequest(): never {
    throw new AppException(ErrorCodes.VALIDATION_FAILED, 'bad', HttpStatus.BAD_REQUEST);
  }

  @Post('unauthorized')
  unauthorized(): never {
    throw new AppException(ErrorCodes.UNAUTHORIZED, 'nope', HttpStatus.UNAUTHORIZED);
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('gone');
  }

  @Post('explode')
  explode(): never {
    throw new Error('boom');
  }

  /** Same route shape as the real SES webhook, to re-check the PR #92 redaction. */
  @Post('notifications/webhooks/ses/:secret')
  webhook(): never {
    throw new AppException(ErrorCodes.UNAUTHORIZED, 'nope', HttpStatus.UNAUTHORIZED);
  }
}

const observed: { method: string; status: number; seconds: number }[] = [];

@Module({
  controllers: [StatusController],
  providers: [
    {
      provide: MetricsService,
      useValue: {
        observeHttp: (method: string, status: number, seconds: number) =>
          void observed.push({ method, status, seconds }),
      },
    },
    HttpObservationService,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
class ProbeModule {}

/** The same bucketing `MetricsService.observeHttp` applies, so the tests assert what ships. */
const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

describe('the recorded status is the status the client received', () => {
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

  /** The single request-log line, parsed. Throws if there is not exactly one. */
  const requestLog = (): Record<string, unknown> => {
    const lines = logged.filter((l) => l.includes('"msg":"request"'));
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0].slice(lines[0].indexOf('{'))) as Record<string, unknown>;
  };

  const cases: [string, string, 'GET' | 'POST', number][] = [
    ['200', 'ok', 'GET', 200],
    ['201', 'created', 'POST', 201],
    ['302', 'moved', 'GET', 302],
    ['400', 'bad-request', 'POST', 400],
    ['401', 'unauthorized', 'POST', 401],
    ['404', 'missing', 'GET', 404],
    ['500', 'explode', 'POST', 500],
  ];

  it.each(cases)(
    'a %s response is logged and counted as that status',
    async (_label, route, method, expected) => {
      const res = await fetch(`${base}/${route}`, { method, redirect: 'manual' });
      expect(res.status).toBe(expected);

      // The metric.
      expect(observed).toHaveLength(1);
      expect(observed[0].status).toBe(expected);
      expect(statusClass(observed[0].status)).toBe(statusClass(expected));

      // The log line.
      expect(requestLog().status).toBe(expected);
    },
  );

  it('produces exactly one metric observation and one log line per request', async () => {
    /*
      `finish` and `close` both fire for a completed response. Without the latch in the
      interceptor this is where a double count would show up — and a doubled error rate is
      just as untrustworthy as a hidden one.
    */
    await fetch(`${base}/ok`);
    expect(observed).toHaveLength(1);
    expect(logged.filter((l) => l.includes('"msg":"request"'))).toHaveLength(1);
  });

  it('counts each of several requests exactly once', async () => {
    for (let i = 0; i < 3; i += 1) await fetch(`${base}/unauthorized`, { method: 'POST' });
    expect(observed).toHaveLength(3);
    expect(observed.every((o) => o.status === 401)).toBe(true);
    expect(logged.filter((l) => l.includes('"msg":"request"'))).toHaveLength(3);
  });

  it('still measures a duration', async () => {
    await fetch(`${base}/explode`, { method: 'POST' });
    // Recorded in seconds, non-negative, and finite — the timing survived moving to `finish`.
    expect(observed[0].seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(observed[0].seconds)).toBe(true);
    expect(typeof requestLog().ms).toBe('number');
  });

  it('marks an ordinary request as not aborted', async () => {
    await fetch(`${base}/ok`);
    // The flag is present only when true, so the common line keeps its existing shape.
    expect(requestLog()).not.toHaveProperty('aborted');
  });

  /*
    ── THE PR #92 REDACTION, RE-CHECKED ON THE ERROR PATH ──────────────────────────────
    This interceptor is where the secret was leaking, and this change rewrote how it records.
    A regression here would put the credential back into the logs, on the 401 path, which is
    exactly the path SNS exercises when a secret is wrong.
  */
  it('still redacts the webhook secret on an error response', async () => {
    const secret = 'k9Vx2pQ7-Rj4LmN8sT1wY6bZ0cH3dF5gA';
    const res = await fetch(`${base}/notifications/webhooks/ses/${secret}`, { method: 'POST' });
    expect(res.status).toBe(401);
    const all = logged.join('\n');
    expect(all).not.toContain(secret);
    expect(all).toContain('notifications/webhooks/ses/[REDACTED]');
    // And the status is now honest about it too.
    expect(requestLog().status).toBe(401);
  });
});

describe('a client that hangs up', () => {
  let app: INestApplication;
  let base: string;
  let logged: string[];
  let spies: jest.SpyInstance[];

  @Controller()
  class SlowController {
    @Get('slow')
    async slow() {
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true };
    }
  }

  @Module({
    controllers: [SlowController],
    providers: [
      {
        provide: MetricsService,
        useValue: {
          observeHttp: (method: string, status: number, seconds: number) =>
            void observed.push({ method, status, seconds }),
        },
      },
      HttpObservationService,
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    ],
  })
  class SlowModule {}

  beforeEach(async () => {
    observed.length = 0;
    logged = [];
    spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );
    const moduleRef = await Test.createTestingModule({ imports: [SlowModule] }).compile();
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

  it('is recorded as 499 rather than as a success', async () => {
    /*
      An abandoned request leaves `res.statusCode` at Express's default, which is a 2xx — the
      exact lie this change exists to stop telling. 499 is nginx's "client closed request": it
      is never sent to anybody, and it exists so these land in 4xx where an operator sees them.
    */
    const controller = new AbortController();
    const inflight = fetch(`${base}/slow`, { signal: controller.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 80));
    controller.abort();
    await inflight;

    // Give the server's `close` event a moment to arrive.
    await new Promise((r) => setTimeout(r, 300));

    expect(observed).toHaveLength(1);
    expect(observed[0].status).toBe(499);
    const line = logged.find((l) => l.includes('"msg":"request"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(line!.indexOf('{')))).toMatchObject({
      status: 499,
      aborted: true,
    });
  });
});
