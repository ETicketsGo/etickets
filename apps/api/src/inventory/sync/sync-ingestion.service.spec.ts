import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { SecretManager } from '../../secrets/secret-manager.interface';
import { SyncIngestionService } from './sync-ingestion.service';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import {
  ProviderPayloadTooLargeError,
  ProviderWebhookSignatureInvalidError,
  UnknownInventorySyncProviderError,
} from './sync.errors';
import type { InventorySyncProvider } from './contracts/sync-provider.interface';

const CFG: Record<string, unknown> = {
  INVENTORY_SYNC_ENABLED: true,
  INVENTORY_SYNC_WEBHOOKS_ENABLED: true,
  INVENTORY_SYNC_MAX_PAYLOAD_BYTES: 1000,
  INVENTORY_SYNC_REPLAY_WINDOW_SECONDS: 300,
};

function make(opts: { enabled?: boolean; valid?: boolean; createThrowsP2002?: boolean } = {}) {
  const provider = {
    providerCode: 'mock-aggregator',
    ownershipMode: 'PROVIDER_AUTHORITATIVE',
    verifyWebhook: jest
      .fn()
      .mockResolvedValue({ valid: opts.valid ?? true, providerTenantId: 't1' }),
    parseWebhook: jest
      .fn()
      .mockResolvedValue([{ externalEventId: 'e1', eventType: 'session.pricing', record: {} }]),
  } as unknown as InventorySyncProvider;
  const registry = {
    resolve: jest.fn().mockReturnValue(provider),
  } as unknown as InventorySyncProviderRegistry;
  const create = opts.createThrowsP2002
    ? jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
    : jest.fn().mockResolvedValue({ id: 'raw1' });
  const prisma = {
    rawProviderEvent: { create, findUnique: jest.fn().mockResolvedValue({ id: 'existing' }) },
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((k: string, d?: unknown) =>
      opts.enabled === false && k.includes('ENABLED') ? false : (CFG[k] ?? d),
    ),
  } as unknown as ConfigService;
  const secrets = { getSecret: jest.fn().mockResolvedValue('sekret') } as unknown as SecretManager;
  const queue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
  const service = new SyncIngestionService(
    prisma,
    registry,
    config,
    new MetricsService(),
    secrets,
    queue as never,
  );
  return { service, provider, prisma, queue, create };
}

describe('SyncIngestionService.ingestWebhook', () => {
  it('fails safe (unknown) when sync is disabled', async () => {
    const { service } = make({ enabled: false });
    await expect(service.ingestWebhook('mock-aggregator', '{}', {})).rejects.toBeInstanceOf(
      UnknownInventorySyncProviderError,
    );
  });

  it('rejects an over-size payload', async () => {
    const { service } = make();
    const big = 'x'.repeat(2000);
    await expect(service.ingestWebhook('mock-aggregator', big, {})).rejects.toBeInstanceOf(
      ProviderPayloadTooLargeError,
    );
  });

  it('fails closed on invalid signature (never persists)', async () => {
    const { service, create } = make({ valid: false });
    await expect(service.ingestWebhook('mock-aggregator', '{}', {})).rejects.toBeInstanceOf(
      ProviderWebhookSignatureInvalidError,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('persists then enqueues a new verified event', async () => {
    const { service, queue, create } = make();
    const res = await service.ingestWebhook('mock-aggregator', '{}', {});
    expect(res).toEqual({ accepted: 1, duplicates: 0 });
    expect(create).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'process',
      expect.objectContaining({ rawEventId: 'raw1' }),
      { jobId: 'raw1' },
    );
  });

  it('is idempotent: a duplicate delivery does not enqueue twice', async () => {
    const { service, queue } = make({ createThrowsP2002: true });
    const res = await service.ingestWebhook('mock-aggregator', '{}', {});
    expect(res).toEqual({ accepted: 0, duplicates: 1 });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
