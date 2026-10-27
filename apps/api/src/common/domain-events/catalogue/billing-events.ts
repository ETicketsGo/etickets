import type { DomainEvent } from '../domain-event';
import { DomainEventFactory } from '../domain-event.factory';
import { DomainEventType, DomainEventVersion, type EventTracing } from './event-types';

/**
 * Organizer billing facts. Ids and states only: no card, bank, tax id or email in a payload.
 * Consumers today: none in production - the entitlement cache is busted directly by the
 * service that commits the change, and these exist so later work (notifications, analytics,
 * provider sync) subscribes instead of being called.
 */
export interface BillingSubscriptionChangedPayload {
  organizationId: string;
  subscriptionId: string;
  /** The state machine event that caused it, e.g. GRANT_COMPLIMENTARY, ACTIVATE. */
  transition: string;
  fromStatus: string | null;
  toStatus: string;
  planCode: string;
  changedAt: string;
}
export type BillingSubscriptionChangedEvent = DomainEvent<BillingSubscriptionChangedPayload>;

export function billingSubscriptionChangedEvent(
  payload: BillingSubscriptionChangedPayload,
  tracing: EventTracing = {},
): BillingSubscriptionChangedEvent {
  return DomainEventFactory.create<BillingSubscriptionChangedPayload>({
    eventType: DomainEventType.BillingSubscriptionChanged,
    eventVersion: DomainEventVersion[DomainEventType.BillingSubscriptionChanged],
    aggregateType: 'OrganizerSubscription',
    aggregateId: payload.subscriptionId,
    tenantId: payload.organizationId,
    ...tracing,
    payload,
  });
}

export interface BillingEntitlementOverrideChangedPayload {
  organizationId: string;
  overrideId: string;
  key: string;
  change: 'GRANTED' | 'REVOKED';
  changedAt: string;
}
export type BillingEntitlementOverrideChangedEvent =
  DomainEvent<BillingEntitlementOverrideChangedPayload>;

export function billingEntitlementOverrideChangedEvent(
  payload: BillingEntitlementOverrideChangedPayload,
  tracing: EventTracing = {},
): BillingEntitlementOverrideChangedEvent {
  return DomainEventFactory.create<BillingEntitlementOverrideChangedPayload>({
    eventType: DomainEventType.BillingEntitlementOverrideChanged,
    eventVersion: DomainEventVersion[DomainEventType.BillingEntitlementOverrideChanged],
    aggregateType: 'EntitlementOverride',
    aggregateId: payload.overrideId,
    tenantId: payload.organizationId,
    ...tracing,
    payload,
  });
}

export interface BillingCreditsGrantedPayload {
  organizationId: string;
  ledgerEntryId: string;
  key: string;
  amount: number;
  grantedAt: string;
}
export type BillingCreditsGrantedEvent = DomainEvent<BillingCreditsGrantedPayload>;

export function billingCreditsGrantedEvent(
  payload: BillingCreditsGrantedPayload,
  tracing: EventTracing = {},
): BillingCreditsGrantedEvent {
  return DomainEventFactory.create<BillingCreditsGrantedPayload>({
    eventType: DomainEventType.BillingCreditsGranted,
    eventVersion: DomainEventVersion[DomainEventType.BillingCreditsGranted],
    aggregateType: 'UsageLedger',
    aggregateId: payload.ledgerEntryId,
    tenantId: payload.organizationId,
    ...tracing,
    payload,
  });
}
