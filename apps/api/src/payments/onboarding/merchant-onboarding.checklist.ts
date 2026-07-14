/**
 * Pure onboarding checklist + state-machine rules (ADR-025). No I/O — the service
 * layer supplies a plain snapshot. Keeps the activation criteria and legal
 * transitions in one testable place.
 */
import { isValidReference } from '../../secrets/secret-reference';

export type OnboardingStatus =
  | 'DRAFT'
  | 'PENDING_CONFIGURATION'
  | 'PENDING_VERIFICATION'
  | 'TESTING'
  | 'READY_FOR_LIVE'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'REJECTED';

export interface OnboardingSnapshot {
  country?: string | null;
  legalBusinessName?: string | null;
  displayName?: string | null;
  settlementCurrency?: string | null;
  provider?: string | null;
  accountIdentifier?: string | null;
  secretKeyRef?: string | null;
  webhookSecretRef?: string | null;
  payoutDestinationRef?: string | null;
  webhookEndpointStatus?: string | null;
  verificationStatus?: string | null;
  termsAcceptedAt?: Date | string | null;
}

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  /** Blocking items must all be done before the merchant can go ACTIVE. */
  blocking: boolean;
}

function present(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null;
}

/** Compute the onboarding checklist for a snapshot. */
export function onboardingChecklist(s: OnboardingSnapshot): ChecklistItem[] {
  const businessOk =
    present(s.country) &&
    present(s.legalBusinessName) &&
    present(s.displayName) &&
    present(s.settlementCurrency);

  const refsOk =
    present(s.secretKeyRef) &&
    present(s.webhookSecretRef) &&
    isValidReference(String(s.secretKeyRef)) &&
    isValidReference(String(s.webhookSecretRef));

  return [
    { key: 'business', label: 'Business details complete', done: businessOk, blocking: true },
    { key: 'provider', label: 'Provider selected', done: present(s.provider), blocking: true },
    {
      key: 'account',
      label: 'Provider account identifier set',
      done: present(s.accountIdentifier),
      blocking: true,
    },
    {
      key: 'secretRefs',
      label: 'Secret references configured (valid)',
      done: refsOk,
      blocking: true,
    },
    {
      key: 'webhook',
      label: 'Webhook endpoint configured',
      done: s.webhookEndpointStatus === 'CONFIGURED' || s.webhookEndpointStatus === 'VERIFIED',
      blocking: true,
    },
    {
      key: 'verified',
      label: 'Merchant verified',
      done: s.verificationStatus === 'VERIFIED',
      blocking: true,
    },
    {
      key: 'terms',
      label: 'Terms accepted',
      done: present(s.termsAcceptedAt),
      blocking: true,
    },
    {
      key: 'payout',
      label: 'Payout destination reference set',
      done: present(s.payoutDestinationRef),
      blocking: false,
    },
  ];
}

/** True when every blocking checklist item is satisfied. */
export function isActivationReady(s: OnboardingSnapshot): boolean {
  return onboardingChecklist(s)
    .filter((i) => i.blocking)
    .every((i) => i.done);
}

/** Legal state transitions for the onboarding workflow. */
const TRANSITIONS: Record<OnboardingStatus, OnboardingStatus[]> = {
  DRAFT: ['PENDING_CONFIGURATION', 'REJECTED'],
  PENDING_CONFIGURATION: ['PENDING_VERIFICATION', 'DRAFT', 'REJECTED'],
  PENDING_VERIFICATION: ['TESTING', 'PENDING_CONFIGURATION', 'REJECTED'],
  TESTING: ['READY_FOR_LIVE', 'PENDING_CONFIGURATION', 'REJECTED'],
  READY_FOR_LIVE: ['ACTIVE', 'TESTING', 'REJECTED'],
  ACTIVE: ['SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'REJECTED'],
  REJECTED: [],
};

export function canTransition(from: OnboardingStatus, to: OnboardingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Editable states — business/provider fields may only change before verification. */
export function isEditable(status: OnboardingStatus): boolean {
  return status === 'DRAFT' || status === 'PENDING_CONFIGURATION';
}
