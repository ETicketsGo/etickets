import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

/**
 * The application must not boot a deployed environment against a Redis on localhost.
 *
 * RedisService is constructed at bootstrap by both the API and the worker, so a refusal here is
 * a refusal to start. Only the refusing path is exercised: an accepted URL opens a connection.
 */
describe('RedisService in a deployed environment', () => {
  const configFor = (values: Record<string, string | undefined>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;

  it('refuses to construct in QA with the localhost default', () => {
    expect(
      () => new RedisService(configFor({ APP_ENV: 'QA', REDIS_URL: 'redis://localhost:6379' })),
    ).toThrow(/REDIS_URL points at localhost/);
  });

  it('refuses to construct in PRODUCTION with no REDIS_URL at all', () => {
    expect(() => new RedisService(configFor({ APP_ENV: 'PRODUCTION' }))).toThrow(
      /REDIS_URL is not set/,
    );
  });
});
