/**
 * Pure fail-closed validator for runtime payment configuration (ADR-020).
 *
 * Enforces the platform's non-negotiable safety rules over the env-scoped provider
 * configs + routes, without touching the DB. The config service runs this on boot
 * and refuses to start a fail-closed environment (staging/production) that has any
 * ERROR-severity issue (rule: "Production must fail closed when payment config is
 * invalid").
 */
import {
  isDummyAllowed,
  isFailClosed,
  isLiveAllowed,
  type PaymentEnvName,
} from './payment-environment';

export type ProviderMode = 'DUMMY' | 'TEST' | 'LIVE';

export interface ProviderConfigView {
  provider: string;
  enabled: boolean;
  mode: ProviderMode;
  publicKey?: string | null;
  secretKeyRef?: string | null;
  webhookSecretRef?: string | null;
}

export interface RouteView {
  country: string;
  currency: string;
  method: string;
  provider: string;
  failoverProvider?: string | null;
  active: boolean;
}

export type IssueSeverity = 'ERROR' | 'WARN';

export interface ValidationIssue {
  severity: IssueSeverity;
  provider?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean; // false when any ERROR is present
  issues: ValidationIssue[];
}

const DUMMY = 'dummy';

/** Placeholder markers that must never reach an enabled real provider. */
const PLACEHOLDER = /(replace_me|replace-me|changeme|change-me|your_|xxxx|placeholder)/i;

function looksPlaceholder(value: string | null | undefined): boolean {
  return !value || value.trim() === '' || PLACEHOLDER.test(value);
}

/**
 * Validate the full payment configuration for one environment. Returns every issue
 * found; `ok` is false if any ERROR exists. The caller decides enforcement (throw
 * on boot for fail-closed envs, warn otherwise).
 */
export function validatePaymentConfig(input: {
  env: PaymentEnvName;
  providers: readonly ProviderConfigView[];
  routes: readonly RouteView[];
}): ValidationResult {
  const { env, providers, routes } = input;
  const issues: ValidationIssue[] = [];
  const err = (message: string, provider?: string) =>
    issues.push({ severity: 'ERROR', message, provider });
  const warn = (message: string, provider?: string) =>
    issues.push({ severity: 'WARN', message, provider });

  const enabled = providers.filter((p) => p.enabled);
  const enabledNames = new Set(enabled.map((p) => p.provider.toLowerCase()));

  for (const p of enabled) {
    const isDummy = p.provider.toLowerCase() === DUMMY || p.mode === 'DUMMY';

    if (isDummy) {
      // Rule: dummy provider must never activate outside local/dev/QA.
      if (!isDummyAllowed(env)) {
        err(
          `Dummy provider is enabled in ${env}; it is only permitted in LOCAL/DEV/QA.`,
          p.provider,
        );
      }
      continue; // dummy has no real credentials to validate
    }

    // Rule: LIVE mode (real money) only in staging/production.
    if (p.mode === 'LIVE' && !isLiveAllowed(env)) {
      err(
        `Provider '${p.provider}' is set to LIVE mode in ${env}; LIVE is only permitted in STAGING/PRODUCTION.`,
        p.provider,
      );
    }
    // Rule: production must run real providers LIVE, never in sandbox.
    if (env === 'PRODUCTION' && p.mode === 'TEST') {
      err(`Provider '${p.provider}' is enabled in PRODUCTION but still in TEST mode.`, p.provider);
    }

    // Rule: real providers must never activate with placeholder/missing credentials.
    if (looksPlaceholder(p.publicKey)) {
      err(`Provider '${p.provider}' is enabled with a missing/placeholder public key.`, p.provider);
    }
    if (looksPlaceholder(p.secretKeyRef)) {
      err(
        `Provider '${p.provider}' is enabled but its secret key reference is missing/placeholder.`,
        p.provider,
      );
    }
    if (looksPlaceholder(p.webhookSecretRef)) {
      err(
        `Provider '${p.provider}' is enabled but its webhook secret reference is missing/placeholder.`,
        p.provider,
      );
    }
  }

  // Routes must only point at providers that are enabled in this environment.
  const activeRoutes = routes.filter((r) => r.active);
  for (const r of activeRoutes) {
    if (!enabledNames.has(r.provider.toLowerCase())) {
      err(
        `Route ${r.country}/${r.currency}/${r.method} references provider '${r.provider}', which is not enabled in ${env}.`,
      );
    }
    if (r.failoverProvider && !enabledNames.has(r.failoverProvider.toLowerCase())) {
      err(
        `Route ${r.country}/${r.currency}/${r.method} failover '${r.failoverProvider}' is not enabled in ${env}.`,
      );
    }
    if (r.failoverProvider && r.failoverProvider.toLowerCase() === r.provider.toLowerCase()) {
      warn(
        `Route ${r.country}/${r.currency}/${r.method} lists the same provider as primary and failover.`,
      );
    }
  }

  // A fail-closed environment must have something able to process payments.
  if (isFailClosed(env)) {
    if (enabled.length === 0) {
      err(`No payment provider is enabled in ${env}; payments cannot be processed.`);
    }
    if (activeRoutes.length === 0) {
      err(`No active payment route is configured in ${env}; payments cannot be routed.`);
    }
  }

  return { ok: !issues.some((i) => i.severity === 'ERROR'), issues };
}
