import { EventEmitter } from 'node:events';
import { Logger, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';
import { HttpObservationService } from './http-observation.service';
import { MetricsService } from '../metrics/metrics.service';

function makeContext(req: unknown, res: unknown, type: 'http' | 'rpc' = 'http'): ExecutionContext {
  const http = { getRequest: () => req, getResponse: () => res };
  return {
    getType: () => type,
    switchToHttp: () => http,
  } as unknown as ExecutionContext;
}

/**
 * A response that behaves like the real one.
 *
 * The interceptor now records at the response's `finish` event rather than when the handler's
 * observable completes, because only the response knows the status the client was actually
 * given — see the file it tests. So the fake has to be an EventEmitter and has to finish, the
 * way Express finishes one.
 */
function makeResponse(statusCode: number) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    writableFinished: boolean;
  };
  res.statusCode = statusCode;
  res.writableFinished = false;
  return res;
}

function run(
  interceptor: LoggingInterceptor,
  context: ExecutionContext,
  res?: ReturnType<typeof makeResponse>,
): Promise<void> {
  const next: CallHandler = { handle: () => of({ ok: true }) };
  return new Promise<void>((resolve, reject) => {
    interceptor.intercept(context, next).subscribe({
      complete: () => {
        // Express sets `writableFinished` immediately before emitting `finish`.
        if (res) {
          res.writableFinished = true;
          res.emit('finish');
        }
        resolve();
      },
      error: reject,
    });
  });
}

describe('LoggingInterceptor', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('emits a single JSON line with exactly the safe fields — no bodies, headers, tokens or PII', async () => {
    const metrics = new MetricsService();
    const observeSpy = jest.spyOn(metrics, 'observeHttp');
    const interceptor = new LoggingInterceptor(new HttpObservationService(metrics));

    const req = {
      method: 'POST',
      originalUrl: '/api/bookings?token=secret-token&email=buyer@example.com',
      url: '/api/bookings?token=secret-token',
      correlationId: 'corr-123',
      headers: { authorization: 'Bearer super-secret-jwt' },
      body: { buyerEmail: 'buyer@example.com', card: '4242424242424242' },
    };
    const res = makeResponse(201);

    await run(interceptor, makeContext(req, res), res);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);

    expect(parsed).toMatchObject({
      level: 'info',
      method: 'POST',
      path: '/api/bookings',
      status: 201,
      correlationId: 'corr-123',
      msg: 'request',
    });
    expect(typeof parsed.ts).toBe('string');
    expect(typeof parsed.ms).toBe('number');

    // Only the whitelisted keys are ever present.
    expect(Object.keys(parsed).sort()).toEqual([
      'correlationId',
      'level',
      'method',
      'ms',
      'msg',
      'path',
      'status',
      'ts',
    ]);

    // Forbidden material must never appear anywhere in the serialized line.
    expect(line).not.toContain('token=secret-token');
    expect(line).not.toContain('buyer@example.com');
    expect(line).not.toContain('Bearer');
    expect(line).not.toContain('4242424242424242');

    // HTTP metrics recorded from the same timing.
    expect(observeSpy).toHaveBeenCalledWith('POST', 201, expect.any(Number));
  });

  it('falls back to "-" when no correlation id is present', async () => {
    const interceptor = new LoggingInterceptor(new HttpObservationService(new MetricsService()));
    const req = { method: 'GET', originalUrl: '/api/events', url: '/api/events' };
    const res = makeResponse(200);
    await run(interceptor, makeContext(req, res), res);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.correlationId).toBe('-');
  });

  it('skips the log line for health/readiness probes but still records metrics', async () => {
    const metrics = new MetricsService();
    const observeSpy = jest.spyOn(metrics, 'observeHttp');
    const interceptor = new LoggingInterceptor(new HttpObservationService(metrics));
    const req = { method: 'GET', originalUrl: '/api/health', url: '/api/health' };

    const res = makeResponse(200);
    await run(interceptor, makeContext(req, res), res);

    expect(logSpy).not.toHaveBeenCalled();
    expect(observeSpy).toHaveBeenCalledWith('GET', 200, expect.any(Number));
  });

  it('is a no-op for non-http execution contexts', async () => {
    const metrics = new MetricsService();
    const observeSpy = jest.spyOn(metrics, 'observeHttp');
    const interceptor = new LoggingInterceptor(new HttpObservationService(metrics));

    await run(interceptor, makeContext({}, {}, 'rpc'));

    expect(logSpy).not.toHaveBeenCalled();
    expect(observeSpy).not.toHaveBeenCalled();
  });
});
