import { MaintenanceService } from './maintenance.service';
import type { RedisService } from '../redis/redis.service';

function makeService(client: { get: jest.Mock; set?: jest.Mock }) {
  const clientMock = { set: jest.fn().mockResolvedValue('OK'), ...client };
  const redis = { client: clientMock } as unknown as RedisService;
  return {
    service: new MaintenanceService(redis),
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
    expect(client.set).toHaveBeenCalledWith('etg:maintenance', JSON.stringify({ enabled: true }));
  });

  it('keeps a real message', async () => {
    const { service, client } = makeService({ get: jest.fn() });
    const res = await service.setState({ enabled: true, message: 'Upgrading DB' });
    expect(res).toEqual({ enabled: true, message: 'Upgrading DB' });
    expect(client.set).toHaveBeenCalledWith(
      'etg:maintenance',
      JSON.stringify({ enabled: true, message: 'Upgrading DB' }),
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
