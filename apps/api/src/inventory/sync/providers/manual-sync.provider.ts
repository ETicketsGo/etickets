import { Injectable } from '@nestjs/common';
import type {
  InventorySyncProvider,
  ProviderChangeBatch,
  ProviderSyncHealth,
  ProviderWebhookEvent,
  ProviderWebhookVerificationResult,
} from '../contracts/sync-provider.interface';
import type { CanonicalInventoryChange } from '../contracts/canonical-change';

/**
 * Reference adapter for ETicketsGo-managed inventory (ADR-040 §25). There is no
 * external provider: no webhooks, no polling. It exists to prove the sync platform is
 * compatible with LOCAL_AUTHORITATIVE ownership — external events can never override
 * local state — and reports local health. Never accepts external ingress.
 */
@Injectable()
export class ManualInventorySyncProvider implements InventorySyncProvider {
  readonly providerCode = 'manual';
  readonly ownershipMode = 'LOCAL_AUTHORITATIVE' as const;
  readonly supportsWebhooks = false;
  readonly supportsPolling = false;

  async verifyWebhook(): Promise<ProviderWebhookVerificationResult> {
    return { valid: false, reason: 'not_supported' };
  }
  async parseWebhook(): Promise<ProviderWebhookEvent[]> {
    return [];
  }
  async fetchChanges(): Promise<ProviderChangeBatch> {
    return { records: [], nextCursor: null, hasMore: false };
  }
  async normalize(): Promise<CanonicalInventoryChange[]> {
    return [];
  }
  async health(): Promise<ProviderSyncHealth> {
    return { state: 'HEALTHY', checkedAt: new Date().toISOString() };
  }
}
