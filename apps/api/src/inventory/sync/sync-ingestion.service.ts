import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { SECRET_MANAGER, type SecretManager } from '../../secrets/secret-manager.interface';
import { InventorySyncProviderRegistry } from './sync-provider.registry';
import { INVENTORY_SYNC_QUEUE, type InventorySyncJob } from './sync-queue.provider';
import {
  ProviderPayloadTooLargeError,
  ProviderWebhookSignatureInvalidError,
  UnknownInventorySyncProviderError,
} from './sync.errors';
import type { ProviderWebhookEvent } from './contracts/sync-provider.interface';

export interface IngestResult {
  accepted: number;
  duplicates: number;
}

/**
 * Webhook ingestion (ADR-040 §7). Verifies the signature FAIL-CLOSED, enforces the
 * size limit, persists each verified event durably (dedup by
 * providerCode+tenant+externalEventId, or a deterministic key derived from safe fields
 * + payload hash when the provider has no stable id), and enqueues async processing —
 * carrying only ids. It does NO normalization or DB sync (that is the worker's job) so
 * the HTTP response returns fast. Invalid signatures are never persisted (avoids a
 * spoofed-traffic storage DoS); they are counted + surfaced as a generic 401.
 */
@Injectable()
export class SyncIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: InventorySyncProviderRegistry,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    @Inject(SECRET_MANAGER) private readonly secrets: SecretManager,
    @Inject(INVENTORY_SYNC_QUEUE) private readonly queue: Queue<InventorySyncJob>,
  ) {}

  private get webhooksEnabled(): boolean {
    return (
      this.config.get<boolean>('INVENTORY_SYNC_ENABLED') === true &&
      this.config.get<boolean>('INVENTORY_SYNC_WEBHOOKS_ENABLED') === true
    );
  }

  async ingestWebhook(
    providerCode: string,
    rawBody: string,
    headers: Record<string, string>,
    correlationId?: string,
  ): Promise<IngestResult> {
    // Fail safe: when webhooks are disabled the endpoint reveals nothing (unknown).
    if (!this.webhooksEnabled) {
      throw new UnknownInventorySyncProviderError();
    }

    const maxBytes = this.config.get<number>('INVENTORY_SYNC_MAX_PAYLOAD_BYTES', 262144);
    if (Buffer.byteLength(rawBody, 'utf8') > maxBytes) {
      this.metrics.recordSyncIngest(providerCode, 'too_large');
      throw new ProviderPayloadTooLargeError();
    }

    // resolve() validates the code + enforces the allowlist (unknown ⇒ fail safe).
    const provider = this.registry.resolve(providerCode);

    const secret = await this.resolveSecret(provider.providerCode);
    const verification = await provider.verifyWebhook({
      rawBody,
      headers,
      secret,
      replayWindowSeconds: this.config.get<number>('INVENTORY_SYNC_REPLAY_WINDOW_SECONDS', 300),
    });
    if (!verification.valid) {
      this.metrics.recordSyncIngest(
        provider.providerCode,
        `verify_${verification.reason ?? 'invalid'}`,
      );
      throw new ProviderWebhookSignatureInvalidError();
    }

    const events = await provider.parseWebhook({ rawBody, headers });
    let accepted = 0;
    let duplicates = 0;
    for (const event of events) {
      const res = await this.acceptEvent(
        provider.providerCode,
        verification.providerTenantId ?? event.providerTenantId ?? '',
        event,
        correlationId,
      );
      res.duplicate ? (duplicates += 1) : (accepted += 1);
    }
    return { accepted, duplicates };
  }

  /**
   * Persist one verified/polled event durably (dedup) and enqueue it if new. Shared by
   * webhook ingestion and the polling coordinator so both paths are identically
   * idempotent — a duplicate NEVER enqueues twice.
   */
  async acceptEvent(
    providerCode: string,
    providerTenantId: string,
    event: ProviderWebhookEvent,
    correlationId?: string,
  ): Promise<{ accepted: boolean; duplicate: boolean }> {
    const persisted = await this.persist(providerCode, providerTenantId, event, correlationId);
    if (persisted.duplicate) {
      this.metrics.recordSyncIngest(providerCode, 'duplicate');
      return { accepted: false, duplicate: true };
    }
    this.metrics.recordSyncIngest(providerCode, 'accepted');
    await this.enqueue(persisted.id, providerCode, correlationId);
    return { accepted: true, duplicate: false };
  }

  /** Persist one verified event; returns {duplicate:true} if already seen (idempotent). */
  private async persist(
    providerCode: string,
    providerTenantId: string,
    event: ProviderWebhookEvent,
    correlationId?: string,
  ): Promise<{ id: string; duplicate: boolean }> {
    const payloadJson = event.record as object;
    const payloadHash = this.hash(JSON.stringify(event.record ?? {}));
    const externalEventId =
      event.externalEventId ??
      this.deterministicKey(providerCode, providerTenantId, event, payloadHash);

    try {
      const created = await this.prisma.rawProviderEvent.create({
        data: {
          providerCode,
          providerTenantId,
          externalEventId,
          eventType: event.eventType,
          eventVersion: event.eventVersion ?? null,
          externalEntityId: event.externalEntityId ?? null,
          providerOccurredAt: event.providerOccurredAt ? new Date(event.providerOccurredAt) : null,
          signatureStatus: 'VERIFIED',
          processingStatus: 'QUEUED',
          payloadHash,
          payloadJson,
          headersMetadata: undefined,
          correlationId: correlationId ?? null,
        },
        select: { id: true },
      });
      return { id: created.id, duplicate: false };
    } catch (err) {
      // Unique violation ⇒ at-least-once re-delivery of an event we already have.
      if (this.isUniqueViolation(err)) {
        const existing = await this.prisma.rawProviderEvent.findUnique({
          where: {
            providerCode_providerTenantId_externalEventId: {
              providerCode,
              providerTenantId,
              externalEventId,
            },
          },
          select: { id: true },
        });
        return { id: existing?.id ?? '', duplicate: true };
      }
      throw err;
    }
  }

  private async enqueue(
    rawEventId: string,
    providerCode: string,
    correlationId?: string,
  ): Promise<void> {
    // Only reached for a NEWLY-persisted event ⇒ a duplicate never enqueues twice.
    await this.queue.add(
      'process',
      { rawEventId, providerCode, correlationId },
      { jobId: rawEventId }, // jobId = rawEventId ⇒ BullMQ also dedupes re-adds
    );
  }

  private async resolveSecret(providerCode: string): Promise<string | undefined> {
    try {
      return await this.secrets.getSecret(`inventory-sync/${providerCode}/webhook-secret`);
    } catch {
      return undefined; // adapter fails closed when the secret is absent
    }
  }

  private deterministicKey(
    providerCode: string,
    tenant: string,
    event: ProviderWebhookEvent,
    payloadHash: string,
  ): string {
    // Never identity-by-timestamp: derive from stable normalized fields + payload hash.
    return `det_${this.hash(
      [providerCode, tenant, event.eventType, event.externalEntityId ?? '', payloadHash].join('|'),
    )}`;
  }

  private hash(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
  }
}
