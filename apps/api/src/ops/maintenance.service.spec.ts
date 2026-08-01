import type { ConfigService } from '@nestjs/config';
import { MaintenanceService } from './maintenance.service';
import type { RedisService } from '../redis/redis.service';

function makeService(client: { get: jest.Mock; set?: jest.Mock }, appEnv = 'LOCAL') {
  const clientMock = { set: jest.fn().mockResolvedValue('OK'), ...client };
  const redis = { client: clientMock } as unknown as RedisService;
  const config = { get: jest.fn(() => appEnv) } as unknown as ConfigService;
  return {
    service: new MaintenanceService(redis, config),
    client: clientMock as { get: jest.Mock; set: jest.Mock },
  };
}

describe('MaintenanceService.getState', () => {
  it('defaults to disabled when the key is unset', async () => {
    const { service } = makeService({ get: jest.fn().mockResolvedValue(null) });
    expect(await service.getState()).toEqual({ enabled: false });
  });

  it('parses a stored enabled flag with a message', async () => {
    const { service } = makeService({
      get: jest.fn().mockResolvedValue(JSON.stringify({ enabled: true, message: 'brb' })),
    });
    expect(await service.getState()).toEqual({ enabled: true, message: 'brb' });
  });

  it('defaults to disabled on malformed JSON', async () => {
    const { service } = makeService({ get: jest.fn().mockResolvedValue('not json') });
    expect(await service.getState()).toEqual({ enabled: false });
  });
});

describe('MaintenanceService.setState', () => {
  it('persists the normalized flag and trims/drops an empty message', async () => {
    const { service, client } = makeService({ get: jest.fn() });
    const res = await service.setState({ enabled: true, message: '   ' });
    expect(res).toEqual({ enabled: true });
    expect(client.set).toHaveBeenCalledWith(
      'etg:local:ops:maintenance',
      JSON.stringify({ enabled: true }),
    );
  });

  it('keeps a real message', async () => {
    const { service, client } = makeService({ get: jest.fn() });
    const res = await service.setState({ enabled: true, message: 'Upgrading DB' });
    expect(res).toEqual({ enabled: true, message: 'Upgrading DB' });
    expect(client.set).toHaveBeenCalledWith(
      'etg:local:ops:maintenance',
      JSON.stringify({ enabled: true, message: 'Upgrading DB' }),
    );
  });

  // Cross-environment isolation: two environments sharing one Redis must not share the flag,
  // or QA enabling maintenance would take production offline.
  it('scopes the key per APP_ENV so environments cannot share the flag', async () => {
    const qa = makeService({ get: jest.fn() }, 'QA');
    const prod = makeService({ get: jest.fn() }, 'PRODUCTION');
    await qa.service.setState({ enabled: true });
    await prod.service.setState({ enabled: false });
    expect(qa.client.set).toHaveBeenCalledWith('etg:qa:ops:maintenance', expect.any(String));
    expect(prod.client.set).toHaveBeenCalledWith(
      'etg:production:ops:maintenance',
      expect.any(String),
    );
  });
});

describe('MaintenanceService.isActive', () => {
  it('caches the read so a second call within the window does not hit Redis again', async () => {
    const get = jest.fn().mockResolvedValue(JSON.stringify({ enabled: true }));
    const { service } = makeService({ get });
    expect(await service.isActive()).toEqual({ enabled: true });
    expect(await service.isActive()).toEqual({ enabled: true });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('fails open (disabled) when Redis errors and nothing is cached', async () => {
    const get = jest.fn().mockRejectedValue(new Error('redis unreachable'));
    const { service } = makeService({ get });
    expect(await service.isActive()).toEqual({ enabled: false });
  });
});
