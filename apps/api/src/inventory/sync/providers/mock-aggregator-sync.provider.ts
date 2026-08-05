import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ProviderPayloadInvalidError,
  ProviderSyncPermanentFailureError,
  ProviderSyncRetryableFailureError,
} from '../sync.errors';
import type {
  InventorySyncProvider,
  ProviderChangeBatch,
  ProviderChangeFetchRequest,
  ProviderChangeRecord,
  ProviderSyncHealth,
  ProviderWebhookEvent,
  ProviderWebhookParseRequest,
  ProviderWebhookVerificationRequest,
  ProviderWebhookVerificationResult,
} from '../contracts/sync-provider.interface';
import type { CanonicalInventoryChange, CanonicalSeatState } from '../contracts/canonical-change';

/**
 * DEV/TEST-ONLY mock aggregator adapter (ADR-040 §25). It is NOT a real vendor and is
 * NOT production-ready — it is registered only when INVENTORY_SYNC_MOCK_PROVIDER_ENABLED
 * is set. It demonstrates the full contract: HMAC-signed webhooks (timestamp+body) with
 * a replay window, typed Zod normalization that REJECTS unknown enums/values visibly,
 * paginated polling fixtures, and failure/rate-limit simulation. It fabricates no real
 * provider behaviour.
 */
const SEAT_STATES: readonly CanonicalSeatState[] = ['AVAILABLE', 'HELD', 'SOLD', 'BLOCKED'];

const seatAvailabilitySchema = z.object({
  externalSessionId: z.string().min(1),
  layoutVersion: z.string().min(1),
  seats: z
    .array(
      z.object({
        externalSeatId: z.string().min(1),
        state: z.enum(['AVAILABLE', 'HELD', 'SOLD', 'BLOCKED']),
      }),
    )
    .max(5000),
});
const quantitySchema = z.object({
  externalSessionId: z.string().min(1),
  remaining: z.number().int(),
  capacity: z.number().int().optional(),
});
const pricingSchema = z.object({
  externalSessionId: z.string().min(1),
  tiers: z
    .array(
      z.object({ code: z.string(), amountMinor: z.number().int(), currency: z.string().length(3) }),
    )
    .max(50),
});

@Injectable()
export class MockAggregatorInventorySyncProvider implements InventorySyncProvider {
  readonly providerCode = 'mock-aggregator';
  readonly ownershipMode = 'PROVIDER_AUTHORITATIVE' as const;
  readonly supportsWebhooks = true;
  readonly supportsPolling = true;

  async verifyWebhook(
    req: ProviderWebhookVerificationRequest,
  ): Promise<ProviderWebhookVerificationResult> {
    if (!req.secret) return { valid: false, reason: 'missing_secret' };
    const sig = req.headers['x-mock-signature'];
    const ts = req.headers['x-mock-timestamp'];
    if (!sig) return { valid: false, reason: 'missing' };
    if (ts) {
      const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
      if (!Number.isFinite(skew) || skew > (req.replayWindowSeconds ?? 300)) {
        return { valid: false, reason: 'replay' };
      }
    }
    const expected = createHmac('sha256', req.secret)
      .update(`${ts ?? ''}.${req.rawBody}`)
      .digest('hex');
    if (!this.safeEqual(sig, expected)) return { valid: false, reason: 'signature' };
    return { valid: true, providerTenantId: req.headers['x-mock-tenant'] || undefined };
  }

  async parseWebhook(req: ProviderWebhookParseRequest): Promise<ProviderWebhookEvent[]> {
    let body: unknown;
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      throw new ProviderPayloadInvalidError('malformed JSON');
    }
    const arr = Array.isArray(body) ? body : (body as { events?: unknown[] })?.events;
    if (!Array.isArray(arr)) throw new ProviderPayloadInvalidError('missing events array');
    return arr.map((e) => {
      const ev = e as Record<string, unknown>;
      return {
        externalEventId: ev.externalEventId as string | undefined,
        eventType: String(ev.eventType ?? ''),
        eventVersion: typeof ev.eventVersion === 'number' ? ev.eventVersion : undefined,
        externalEntityId: ev.externalEntityId as string | undefined,
        providerTenantId: ev.providerTenantId as string | undefined,
        providerOccurredAt: ev.providerOccurredAt as string | undefined,
        record: ev.data ?? {},
      };
    });
  }

  async fetchChanges(req: ProviderChangeFetchRequest): Promise<ProviderChangeBatch> {
    // Deterministic paginated fixture: two pages then done, cursor "p1" → "p2" → null.
    const cursor = req.cursor ?? null;
    if (cursor === null) {
      return {
        records: [this.fixtureRecord('mock-evt-1', 1)],
        nextCursor: 'p1',
        hasMore: true,
      };
    }
    if (cursor === 'p1') {
      return { records: [this.fixtureRecord('mock-evt-2', 2)], nextCursor: null, hasMore: false };
    }
    return { records: [], nextCursor: null, hasMore: false };
  }

  async normalize(
    event: ProviderWebhookEvent | ProviderChangeRecord,
  ): Promise<CanonicalInventoryChange[]> {
    const base = {
      externalVersion: event.eventVersion,
      providerOccurredAt: event.providerOccurredAt,
      providerTenantId: event.providerTenantId,
    };
    const rec = event.record;
    switch (event.eventType) {
      case 'session.availability.seats': {
        const p = this.parse(seatAvailabilitySchema, rec);
        // Defensive: reject any state not in the canonical enum (never silent-default).
        for (const s of p.seats)
          if (!SEAT_STATES.includes(s.state))
            throw new ProviderPayloadInvalidError('unknown seat state');
        return [
          {
            kind: 'UPDATE_SEAT_AVAILABILITY',
            externalEntityType: 'SEAT_AVAILABILITY',
            externalEntityId: p.externalSessionId,
            externalSessionId: p.externalSessionId,
            layoutVersion: p.layoutVersion,
            seats: p.seats,
            ...base,
          },
        ];
      }
      case 'session.availability.quantity': {
        const p = this.parse(quantitySchema, rec);
        if (p.remaining < 0) throw new ProviderPayloadInvalidError('negative remaining');
        return [
          {
            kind: 'UPDATE_QUANTITY_AVAILABILITY',
            externalEntityType: 'QUANTITY_AVAILABILITY',
            externalEntityId: p.externalSessionId,
            externalSessionId: p.externalSessionId,
            remaining: p.remaining,
            capacity: p.capacity,
            ...base,
          },
        ];
      }
      case 'session.pricing': {
        const p = this.parse(pricingSchema, rec);
        return [
          {
            kind: 'UPDATE_PRICING',
            externalEntityType: 'PRICING',
            externalEntityId: p.externalSessionId,
            externalSessionId: p.externalSessionId,
            tiers: p.tiers,
            ...base,
          },
        ];
      }
      case 'session.cancel': {
        const p = this.parse(z.object({ externalSessionId: z.string().min(1) }), rec);
        return [
          {
            kind: 'CANCEL_SESSION',
            externalEntityType: 'SESSION',
            externalEntityId: p.externalSessionId,
            externalSessionId: p.externalSessionId,
            ...base,
          },
        ];
      }
      case 'simulate.retryable':
        throw new ProviderSyncRetryableFailureError('simulated transient provider failure');
      case 'simulate.permanent':
        throw new ProviderSyncPermanentFailureError('simulated permanent failure');
      default:
        // Unsupported event type is visible, never silently ignored.
        throw new ProviderPayloadInvalidError(`unsupported event type: ${event.eventType}`);
    }
  }

  async health(): Promise<ProviderSyncHealth> {
    return { state: 'HEALTHY', checkedAt: new Date().toISOString() };
  }

  /** Sign a body the way the mock provider does — for fixtures/tests only. */
  static sign(secret: string, rawBody: string, timestamp: number): string {
    return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  }

  private fixtureRecord(id: string, version: number): ProviderChangeRecord {
    return {
      externalEventId: id,
      eventType: 'session.availability.quantity',
      eventVersion: version,
      externalEntityId: 'sess-poll-1',
      providerOccurredAt: undefined,
      record: { externalSessionId: 'sess-poll-1', remaining: 100 - version },
    };
  }

  private parse<T>(schema: z.ZodType<T>, rec: unknown): T {
    const result = schema.safeParse(rec);
    if (!result.success) throw new ProviderPayloadInvalidError('schema validation failed');
    return result.data;
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
