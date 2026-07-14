import type { ConfigService } from '@nestjs/config';
import { MockPaymentProvider } from '../mock-payment.provider';
import { PayPalPaymentProvider } from '../paypal-payment.provider';
import { RazorpayPaymentProvider } from '../razorpay-payment.provider';
import { SquarePaymentProvider } from '../square-payment.provider';
import { StripePaymentProvider } from '../stripe-payment.provider';
import type { PaymentProvider } from '../payment-provider.interface';

/**
 * Per-provider credential binding (ADR-024). This is the ONLY place provider-
 * specific credential knowledge lives — how a PaymentProviderConfig's public key /
 * secret references / endpoint map to the exact env keys the adapter reads, how a
 * key's test-vs-live mode is classified, and how the adapter is constructed. The
 * factory is otherwise provider-agnostic.
 */
export type KeyMode = 'test' | 'live' | 'unknown';

export interface CredentialContext {
  publicKey?: string;
  secret?: string;
  apiBaseUrl?: string;
}

export interface ProviderBinding {
  provider: string;
  /** config.publicKey → this adapter env key (non-secret identifier). */
  publicKeyEnv?: string;
  /** config.secretKeyRef → resolved secret → this adapter env key. */
  secretKeyEnv?: string;
  /** config.webhookSecretRef → resolved secret → this adapter env key. */
  webhookSecretEnv?: string;
  /** config.apiBaseUrl → this adapter env key. */
  apiBaseUrlEnv?: string;
  /** Non-secret operational env keys passed through from process.env (URLs, etc). */
  passthroughEnv: string[];
  /** Classify test vs live from the credential material. */
  classifyMode(ctx: CredentialContext): KeyMode;
  /** Build the adapter from a (shim) ConfigService populated with the mapped keys. */
  construct(config: ConfigService): PaymentProvider;
}

const stripe: ProviderBinding = {
  provider: 'stripe',
  secretKeyEnv: 'STRIPE_SECRET_KEY',
  webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET',
  passthroughEnv: ['STRIPE_SUCCESS_URL', 'STRIPE_CANCEL_URL'],
  classifyMode: ({ secret }) =>
    secret?.startsWith('sk_live_') ? 'live' : secret?.startsWith('sk_test_') ? 'test' : 'unknown',
  construct: (config) => new StripePaymentProvider(config),
};

const razorpay: ProviderBinding = {
  provider: 'razorpay',
  publicKeyEnv: 'RAZORPAY_KEY_ID',
  secretKeyEnv: 'RAZORPAY_KEY_SECRET',
  webhookSecretEnv: 'RAZORPAY_WEBHOOK_SECRET',
  passthroughEnv: [],
  classifyMode: ({ publicKey }) =>
    publicKey?.startsWith('rzp_live_')
      ? 'live'
      : publicKey?.startsWith('rzp_test_')
        ? 'test'
        : 'unknown',
  construct: (config) => new RazorpayPaymentProvider(config),
};

const paypal: ProviderBinding = {
  provider: 'paypal',
  publicKeyEnv: 'PAYPAL_CLIENT_ID',
  secretKeyEnv: 'PAYPAL_CLIENT_SECRET',
  webhookSecretEnv: 'PAYPAL_WEBHOOK_ID',
  apiBaseUrlEnv: 'PAYPAL_API_BASE_URL',
  passthroughEnv: ['PAYPAL_RETURN_URL', 'PAYPAL_CANCEL_URL'],
  classifyMode: ({ apiBaseUrl }) =>
    !apiBaseUrl ? 'unknown' : /sandbox/i.test(apiBaseUrl) ? 'test' : 'live',
  construct: (config) => new PayPalPaymentProvider(config),
};

const square: ProviderBinding = {
  provider: 'square',
  publicKeyEnv: 'SQUARE_LOCATION_ID',
  secretKeyEnv: 'SQUARE_ACCESS_TOKEN',
  webhookSecretEnv: 'SQUARE_WEBHOOK_SIGNATURE_KEY',
  apiBaseUrlEnv: 'SQUARE_API_BASE_URL',
  passthroughEnv: ['SQUARE_API_VERSION', 'SQUARE_WEBHOOK_URL'],
  classifyMode: ({ apiBaseUrl }) =>
    !apiBaseUrl ? 'unknown' : /squareupsandbox/i.test(apiBaseUrl) ? 'test' : 'live',
  construct: (config) => new SquarePaymentProvider(config),
};

const PROVIDER_BINDINGS: Record<string, ProviderBinding> = { stripe, razorpay, paypal, square };

/** The real-provider binding for a name, or undefined for dummy/unknown. */
export function providerBinding(name: string): ProviderBinding | undefined {
  return PROVIDER_BINDINGS[name.toLowerCase()];
}

/** Provider names the factory can bind (real providers only; dummy is special). */
export function boundProviderNames(): string[] {
  return Object.keys(PROVIDER_BINDINGS);
}

/** True when this name is the simulated provider (config 'dummy' / adapter 'mock'). */
export function isDummyProvider(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'dummy' || n === 'mock';
}

export { MockPaymentProvider };
