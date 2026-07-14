import { Logger, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';
import { MetricsService } from '../metrics/metrics.service';

function makeContext(req: unknown, res: unknown, type: 'http' | 'rpc' = 'http'): ExecutionContext {
  const http = { getRequest: () => req, getResponse: () => res };
  return {
    getType: () => type,
    switchToHttp: () => http,
  } as unknown as ExecutionContext;
}

function run(interceptor: LoggingInterceptor, context: ExecutionContext): Promise<void> {
  const next: CallHandler = { handle: () => of({ ok: true }) };
  return new Promise<void>((resolve, reject) => {
    interceptor.intercept(context, next).subscribe({ complete: resolve, error: reject });
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
    const interceptor = new LoggingInterceptor(metrics);

    const req = {
      method: 'POST',
      originalUrl: '/api/bookings?token=secret-token&email=buyer@example.com',
      url: '/api/bookings?token=secret-token',
      correlationId: 'corr-123',
      headers: { authorization: 'Bearer super-secret-jwt' },
      body: { buyerEmail: 'buyer@example.com', card: '4242424242424242' },
    };
    const res = { statusCode: 201 };

    await run(interceptor, makeContext(req, res));

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
    const interceptor = new LoggingInterceptor(new MetricsService());
    const req = { method: 'GET', originalUrl: '/api/events', url: '/api/events' };
    await run(interceptor, makeContext(req, { statusCode: 200 }));
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.correlationId).toBe('-');
  });

  it('skips the log line for health/readiness probes but still records metrics', async () => {
    const metrics = new MetricsService();
    const observeSpy = jest.spyOn(metrics, 'observeHttp');
    const interceptor = new LoggingInterceptor(metrics);
    const req = { method: 'GET', originalUrl: '/api/health', url: '/api/health' };

    await run(interceptor, makeContext(req, { statusCode: 200 }));

    expect(logSpy).not.toHaveBeenCalled();
    expect(observeSpy).toHaveBeenCalledWith('GET', 200, expect.any(Number));
  });

  it('is a no-op for non-http execution contexts', async () => {
    const metrics = new MetricsService();
    const observeSpy = jest.spyOn(metrics, 'observeHttp');
    const interceptor = new LoggingInterceptor(metrics);

    await run(interceptor, makeContext({}, {}, 'rpc'));

    expect(logSpy).not.toHaveBeenCalled();
    expect(observeSpy).not.toHaveBeenCalled();
  });
});
