/**
 * Pure environment-promotion logic (ADR-026). Given assembled facts about a source
 * provider config and the target environment, produce the promotion report. No I/O
 * — the service gathers async facts (secret health, resolution, provider health)
 * and passes them in. Also holds the secret-reference remap (env token → target).
 */
import type { PaymentEnvName } from '../configuration/payment-environment';

const ENV_TOKENS = new Set(['local', 'dev', 'qa', 'uat', 'test', 'live', 'staging', 'production']);

/** The secret-store token a target environment's references should use. */
export function targetRefToken(env: PaymentEnvName): string {
  if (env === 'PRODUCTION') return 'production';
  if (env === 'STAGING') return 'staging';
  return 'test'; // LOCAL/DEV/QA/UAT use sandbox secrets
}

/** The mode a target environment's real provider must run in. */
export function expectedMode(env: PaymentEnvName): 'TEST' | 'LIVE' {
  return env === 'STAGING' || env === 'PRODUCTION' ? 'LIVE' : 'TEST';
}

/**
 * Remap a secret reference for the target environment by replacing its recognized
 * env-token segment. e.g. payments/stripe/test/secret-key → (PRODUCTION) →
 * payments/stripe/production/secret-key. Refs without an env token are unchanged.
 */
export function remapSecretRef(
  ref: string | null | undefined,
  toEnv: PaymentEnvName,
): string | null {
  if (!ref) return null;
  const token = targetRefToken(toEnv);
  return ref
    .split('/')
    .map((seg) => (ENV_TOKENS.has(seg.toLowerCase()) ? token : seg))
    .join('/');
}

export interface PromotionFacts {
  fromEnv: PaymentEnvName;
  toEnv: PaymentEnvName;
  provider: string;
  sourceEnabled: boolean;
  isDummy: boolean;
  secretRefsPresent: boolean;
  secretManagerHealthy: boolean;
  secretsResolvable: boolean;
  webhookConfigured: boolean;
  apiBaseUrl?: string | null;
  classified: 'test' | 'live' | 'unknown';
  routeExistsInTarget: boolean;
  merchantVerifiedInTarget: boolean;
  providerHealthPassing: boolean;
  allowLiveKeysInLowerEnv: boolean;
}

export interface PromotionCheck {
  key: string;
  label: string;
  passed: boolean;
  blocking: boolean;
  detail?: string;
}

export interface PromotionReport {
  fromEnv: PaymentEnvName;
  toEnv: PaymentEnvName;
  provider: string;
  ok: boolean;
  checks: PromotionCheck[];
}

export function evaluatePromotion(f: PromotionFacts): PromotionReport {
  const expected = expectedMode(f.toEnv);
  const isProd = f.toEnv === 'PRODUCTION';
  const isLower = f.toEnv === 'LOCAL' || f.toEnv === 'DEV' || f.toEnv === 'QA' || f.toEnv === 'UAT';

  const checks: PromotionCheck[] = [
    {
      key: 'provider-enabled',
      label: 'Provider enabled in source',
      passed: f.sourceEnabled,
      blocking: true,
    },
    { key: 'dummy-disabled', label: 'Not the dummy provider', passed: !f.isDummy, blocking: true },
    {
      key: 'mode-correct',
      label: `Credentials match required mode (${expected})`,
      passed:
        expected === 'LIVE'
          ? f.classified === 'live'
          : f.classified !== 'live' || f.allowLiveKeysInLowerEnv,
      blocking: true,
    },
    {
      key: 'secret-refs',
      label: 'Required secret references present',
      passed: f.secretRefsPresent,
      blocking: true,
    },
    {
      key: 'secret-manager',
      label: 'Secret manager healthy',
      passed: f.secretManagerHealthy,
      blocking: true,
    },
    {
      key: 'secrets-resolvable',
      label: 'Target secrets resolve',
      passed: f.secretsResolvable,
      blocking: true,
    },
    { key: 'webhook', label: 'Webhook configured', passed: f.webhookConfigured, blocking: true },
    {
      key: 'production-endpoint',
      label: 'Production endpoint selected',
      passed: !isProd || !/sandbox/i.test(f.apiBaseUrl ?? ''),
      blocking: isProd,
    },
    {
      key: 'no-test-keys-in-prod',
      label: 'No test credentials in production',
      passed: !isProd || f.classified !== 'test',
      blocking: true,
    },
    {
      key: 'no-live-keys-in-lower',
      label: 'No live credentials in a lower environment',
      passed: !isLower || f.classified !== 'live' || f.allowLiveKeysInLowerEnv,
      blocking: true,
    },
    {
      key: 'supported-route',
      label: 'A route exists for this provider in target',
      passed: f.routeExistsInTarget,
      blocking: true,
    },
    {
      key: 'provider-health',
      label: 'Provider health passing',
      passed: f.providerHealthPassing,
      blocking: true,
    },
    {
      key: 'merchant-verified',
      label: 'A verified merchant exists in target',
      passed: f.merchantVerifiedInTarget,
      blocking: false,
    },
  ];

  return {
    fromEnv: f.fromEnv,
    toEnv: f.toEnv,
    provider: f.provider,
    ok: checks.filter((c) => c.blocking).every((c) => c.passed),
    checks,
  };
}

/** Valid forward promotion edges. */
const PROMOTION_PATH: Record<string, string> = {
  DEV: 'QA',
  QA: 'UAT',
  UAT: 'STAGING',
  STAGING: 'PRODUCTION',
};

export function isValidPromotionEdge(fromEnv: PaymentEnvName, toEnv: PaymentEnvName): boolean {
  return PROMOTION_PATH[fromEnv] === toEnv;
}
