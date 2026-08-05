import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Durable polling checkpoints + single-owner leases (ADR-040 §10). Uses PostgreSQL
 * (the ProviderSyncCheckpoint row) for the lease — an atomic conditional UPDATE — so
 * only one node polls a (provider, tenant, resource) at a time, reusing the DB we
 * already depend on rather than a new distributed-locking framework. The cursor is
 * advanced ONLY after records are durably accepted.
 */
@Injectable()
export class SyncCheckpointService {
  /** Stable per-process id used as the lease owner. */
  private readonly nodeId = randomUUID();

  constructor(private readonly prisma: PrismaService) {}

  private key(providerCode: string, providerTenantId: string, resource: string) {
    return {
      providerCode_providerTenantId_resource: { providerCode, providerTenantId, resource },
    };
  }

  /** Ensure a checkpoint row exists; returns it. */
  async ensure(providerCode: string, providerTenantId: string, resource: string) {
    return this.prisma.providerSyncCheckpoint.upsert({
      where: this.key(providerCode, providerTenantId, resource),
      create: { providerCode, providerTenantId, resource },
      update: {},
    });
  }

  /**
   * Atomically acquire the poll lease if it is free or expired. Returns true on
   * success. A running node holds the lease for `leaseSeconds`; a crash simply lets it
   * expire so another node can take over.
   */
  async acquireLease(
    providerCode: string,
    providerTenantId: string,
    resource: string,
    leaseSeconds: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    await this.ensure(providerCode, providerTenantId, resource);
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const res = await this.prisma.providerSyncCheckpoint.updateMany({
      where: {
        providerCode,
        providerTenantId,
        resource,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseOwner: this.nodeId, leaseExpiresAt: expiresAt },
    });
    return res.count === 1;
  }

  async releaseLease(
    providerCode: string,
    providerTenantId: string,
    resource: string,
  ): Promise<void> {
    await this.prisma.providerSyncCheckpoint.updateMany({
      where: { providerCode, providerTenantId, resource, leaseOwner: this.nodeId },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }

  /** Advance the cursor/watermark AFTER a page's records are durably accepted. */
  async advance(
    providerCode: string,
    providerTenantId: string,
    resource: string,
    cursor: string | null,
    nextPollAt: Date,
  ): Promise<void> {
    await this.prisma.providerSyncCheckpoint.update({
      where: this.key(providerCode, providerTenantId, resource),
      data: { cursor, lastSuccessfulPollAt: new Date(), nextPollAt, failureCount: 0 },
    });
  }

  async recordFailure(
    providerCode: string,
    providerTenantId: string,
    resource: string,
    nextPollAt: Date,
  ): Promise<void> {
    await this.prisma.providerSyncCheckpoint.update({
      where: this.key(providerCode, providerTenantId, resource),
      data: { failureCount: { increment: 1 }, nextPollAt },
    });
  }

  async get(providerCode: string, providerTenantId: string, resource: string) {
    return this.prisma.providerSyncCheckpoint.findUnique({
      where: this.key(providerCode, providerTenantId, resource),
    });
  }
}
