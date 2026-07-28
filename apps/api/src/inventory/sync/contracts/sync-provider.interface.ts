import type { CanonicalInventoryChange, InventoryOwnershipMode } from './canonical-change';

/**
 * Provider-neutral inventory SYNC adapter (ADR-040). One adapter per external
 * provider translates untrusted vendor input into canonical changes. Provider-specific
 * types NEVER leak past this boundary — callers see only these DTOs + the canonical
 * vocabulary. Adapters verify, parse, fetch (poll), normalize, and report health; they
 * do not persist, map, or mutate the domain (the platform services do).
 */

export interface ProviderWebhookVerificationRequest {
  /** The exact raw request body (bytes as string) required for signature checks. */
  rawBody: string;
  headers: Record<string, string>;
  /** Resolved provider webhook secret (from SecretManager) — never logged. */
  secret?: string;
  /** Replay-window tolerance (seconds) for timestamped signatures. */
  replayWindowSeconds?: number;
}

export interface ProviderWebhookVerificationResult {
  valid: boolean;
  /** Machine reason when invalid (safe): `signature` | `replay` | `timestamp` | `missing`. */
  reason?: string;
  /** Provider tenant this payload belongs to, if the signature scheme conveys it. */
  providerTenantId?: string;
}

export interface ProviderWebhookParseRequest {
  rawBody: string;
  headers: Record<string, string>;
}

/** A single provider event extracted from a (verified) webhook body. */
export interface ProviderWebhookEvent {
  /** Stable provider event id; when absent the platform derives a deterministic key. */
  externalEventId?: string;
  eventType: string;
  eventVersion?: number;
  externalEntityId?: string;
  providerTenantId?: string;
  /** ISO-8601 provider event time, if supplied. */
  providerOccurredAt?: string;
  /** The already-parsed, provider-shaped record (adapter-internal shape). */
  record: unknown;
}

export interface ProviderChangeFetchRequest {
  providerTenantId?: string;
  /** Opaque cursor/watermark from the durable checkpoint (null ⇒ start). */
  cursor?: string | null;
  /** Max records per page (provider rate-limit aware). */
  pageSize?: number;
  /** Bounded time window for incremental sync. */
  since?: string;
}

export interface ProviderChangeRecord {
  externalEventId?: string;
  eventType: string;
  eventVersion?: number;
  externalEntityId?: string;
  providerTenantId?: string;
  providerOccurredAt?: string;
  record: unknown;
}

export interface ProviderChangeBatch {
  records: ProviderChangeRecord[];
  /** Next cursor to persist AFTER all records are durably accepted (never before). */
  nextCursor: string | null;
  /** True when more pages remain for this poll. */
  hasMore: boolean;
}

export interface ProviderAcknowledgementRequest {
  providerTenantId?: string;
  externalEventIds: string[];
}

export type ProviderSyncHealthState = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'DISABLED' | 'UNKNOWN';

export interface ProviderSyncHealth {
  state: ProviderSyncHealthState;
  /** Short machine reason (never secrets/PII). */
  reason?: string;
  checkedAt: string;
}

export interface InventorySyncProvider {
  readonly providerCode: string;
  /** How this provider's inventory ownership is treated by the sync rules. */
  readonly ownershipMode: InventoryOwnershipMode;
  /** Whether this provider pushes webhooks / supports polling. */
  readonly supportsWebhooks: boolean;
  readonly supportsPolling: boolean;

  verifyWebhook(
    request: ProviderWebhookVerificationRequest,
  ): Promise<ProviderWebhookVerificationResult>;

  parseWebhook(request: ProviderWebhookParseRequest): Promise<ProviderWebhookEvent[]>;

  fetchChanges(request: ProviderChangeFetchRequest): Promise<ProviderChangeBatch>;

  normalize(
    event: ProviderWebhookEvent | ProviderChangeRecord,
  ): Promise<CanonicalInventoryChange[]>;

  acknowledge?(request: ProviderAcknowledgementRequest): Promise<void>;

  health(): Promise<ProviderSyncHealth>;
}

export const INVENTORY_SYNC_PROVIDER = Symbol('INVENTORY_SYNC_PROVIDER');
