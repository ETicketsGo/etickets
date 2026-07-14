import type { PaymentEnvName } from '../../configuration/payment-environment';
import type { KeyMode } from './provider-binding';

/**
 * Pure validation of resolved provider credentials (ADR-024). Enforces the
 * test/live separation and placeholder rules the production-binding layer depends
 * on. Operates on classified material only — it never logs or returns secret
 * values. Returns the list of blocking reasons; empty means the credentials may
 * be used to construct the provider.
 */
const PLACEHOLDER =
  /(replace_me|replace-me|replace_from|changeme|change-me|your_|xxxx|placeholder|CHANGE_ME)/i;

/** Environments where LIVE-classified keys are refused unless explicitly allowed. */
const LOWER_ENVS = new Set<PaymentEnvName>(['LOCAL', 'DEV', 'QA', 'UAT']);

export interface CredentialCheckInput {
  env: PaymentEnvName;
  mode: 'DUMMY' | 'TEST' | 'LIVE';
  classified: KeyMode;
  publicKey?: string;
  secret?: string;
  webhookSecret?: string;
  requiresSecret: boolean;
  requiresWebhookSecret: boolean;
  allowLiveKeysInLowerEnv?: boolean;
}

function looksPlaceholder(value: string | undefined): boolean {
  return !value || value.trim() === '' || PLACEHOLDER.test(value);
}

export function validateCredentials(input: CredentialCheckInput): string[] {
  const reasons: string[] = [];

  // Required secrets must resolve to a real value (fail closed).
  if (input.requiresSecret && (!input.secret || input.secret.trim() === '')) {
    reasons.push('required secret is missing');
  }
  if (input.requiresWebhookSecret && (!input.webhookSecret || input.webhookSecret.trim() === '')) {
    reasons.push('required webhook secret is missing');
  }

  // Placeholder credentials must never activate a real provider.
  if (input.publicKey !== undefined && looksPlaceholder(input.publicKey)) {
    reasons.push('public key looks like a placeholder');
  }
  if (input.secret !== undefined && input.secret !== '' && looksPlaceholder(input.secret)) {
    reasons.push('secret looks like a placeholder');
  }
  if (
    input.webhookSecret !== undefined &&
    input.webhookSecret !== '' &&
    looksPlaceholder(input.webhookSecret)
  ) {
    reasons.push('webhook secret looks like a placeholder');
  }

  // Test/live separation.
  if (input.classified === 'test' && input.env === 'PRODUCTION') {
    reasons.push('test credentials are not allowed in PRODUCTION');
  }
  if (input.classified === 'live' && LOWER_ENVS.has(input.env) && !input.allowLiveKeysInLowerEnv) {
    reasons.push(`live credentials are not allowed in ${input.env}`);
  }

  // Declared mode must agree with the actual credential material.
  if (input.mode === 'LIVE' && input.classified === 'test') {
    reasons.push('mode is LIVE but the credentials are test credentials');
  }
  if (input.mode === 'TEST' && input.classified === 'live') {
    reasons.push('mode is TEST but the credentials are live credentials');
  }

  return reasons;
}
