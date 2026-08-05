import type { ConfigService } from '@nestjs/config';
import { CacheService } from './cache.service';
import type { RedisService } from '../redis/redis.service';

describe('CacheService.getOrSet', () => {
  function makeService(client: { get: jest.Mock; set: jest.Mock }, appEnv = 'STAGING') {
    const redis = { client } as unknown as RedisService;
    const config = { get: jest.fn(() => appEnv) } as unknown as ConfigService;
    return new CacheService(redis, config);
  }

  it('returns the cached value on a hit without calling the producer', async () => {
    const client = {
      get: jest.fn().mockResolvedValue(JSON.stringify({ hello: 'world' })),
      set: jest.fn(),
    };
    const service = makeService(client);
    const producer = jest.fn().mockResolvedValue({ hello: 'fresh' });

    const result = await service.getOrSet('k', 30, producer);

    expect(result).toEqual({ hello: 'world' });
    expect(producer).not.toHaveBeenCalled();
    expect(client.set).not.toHaveBeenCalled();
  });

  it('runs the producer and stores it with the given TTL on a miss', async () => {
    const client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const service = makeService(client);
    const value = { hello: 'fresh' };
    const producer = jest.fn().mockResolvedValue(value);

    const result = await service.getOrSet('k', 45, producer);

    expect(result).toBe(value);
    expect(producer).toHaveBeenCalledTimes(1);
    // Key is env-namespaced (P6.2) so environments sharing a Redis never collide.
    expect(client.set).toHaveBeenCalledWith('etg:staging:cache:k', JSON.stringify(value), 'EX', 45);
  });

  it('namespaces the read key by environment (P6.2 isolation)', async () => {
    const client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const service = makeService(client, 'PRODUCTION');
    await service.getOrSet('discovery:home', 30, jest.fn().mockResolvedValue({}));
    expect(client.get).toHaveBeenCalledWith('etg:production:cache:discovery:home');
  });

  it('falls back to the producer (and still returns) when Redis read errors', async () => {
    const client = {
      get: jest.fn().mockRejectedValue(new Error('redis down')),
      set: jest.fn(),
    };
    const service = makeService(client);
    const value = { hello: 'fresh' };
    const producer = jest.fn().mockResolvedValue(value);

    const result = await service.getOrSet('k', 30, producer);

    expect(result).toBe(value);
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('still returns the produced value when the Redis write errors', async () => {
    const client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockRejectedValue(new Error('write failed')),
    };
    const service = makeService(client);
    const value = { hello: 'fresh' };
    const producer = jest.fn().mockResolvedValue(value);

    const result = await service.getOrSet('k', 30, producer);

    expect(result).toBe(value);
    expect(producer).toHaveBeenCalledTimes(1);
  });
});
