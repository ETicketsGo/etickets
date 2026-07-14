import { HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MaintenanceGuard } from './maintenance.guard';
import { MaintenanceService } from './maintenance.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RedisService } from '../redis/redis.service';

/** Guard wired to a real MaintenanceService over a mocked Redis client. */
function makeGuard(get: jest.Mock) {
  const redis = { client: { get, set: jest.fn() } } as unknown as RedisService;
  const service = new MaintenanceService(redis);
  const config = {
    get: jest.fn((_k: string, d?: unknown) => d ?? 'api'),
  } as unknown as ConfigService;
  return new MaintenanceGuard(service, config);
}

function ctx(path: string): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ path }) }),
  } as unknown as ExecutionContext;
}

describe('MaintenanceGuard', () => {
  it('ALLOWS all requests when the flag is OFF (default)', async () => {
    const guard = makeGuard(jest.fn().mockResolvedValue(null));
    await expect(guard.canActivate(ctx('/api/events'))).resolves.toBe(true);
  });

  it('ALLOWS all requests when Redis errors (fail-open)', async () => {
    const guard = makeGuard(jest.fn().mockRejectedValue(new Error('redis down')));
    await expect(guard.canActivate(ctx('/api/public/events'))).resolves.toBe(true);
  });

  it('returns 503 for a non-exempt route when the flag is ON', async () => {
    const guard = makeGuard(
      jest.fn().mockResolvedValue(JSON.stringify({ enabled: true, message: 'brb' })),
    );
    try {
      await guard.canActivate(ctx('/api/events'));
      fail('expected the guard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      const e = err as AppException;
      expect(e.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(e.code).toBe(ErrorCodes.MAINTENANCE_MODE);
      expect(e.message).toBe('brb');
    }
  });

  it.each([
    '/api/health',
    '/api/ready',
    '/api/metrics',
    '/api/auth/login',
    '/api/auth/refresh',
    '/api/admin/dashboard',
    '/api/admin/ops/maintenance',
    '/api/admin/ops/health',
  ])('EXEMPTS %s even when the flag is ON', async (path) => {
    const guard = makeGuard(jest.fn().mockResolvedValue(JSON.stringify({ enabled: true })));
    await expect(guard.canActivate(ctx(path))).resolves.toBe(true);
  });

  it('blocks a non-exempt route that merely resembles an exempt prefix', async () => {
    const guard = makeGuard(jest.fn().mockResolvedValue(JSON.stringify({ enabled: true })));
    // "/api/healthcheck" is NOT "/api/health" — must be blocked.
    await expect(guard.canActivate(ctx('/api/healthcheck'))).rejects.toBeInstanceOf(AppException);
  });
});
