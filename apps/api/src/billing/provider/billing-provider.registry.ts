import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCodes } from '../../common/errors';
import { SECRET_MANAGER, type SecretManager } from '../../secrets/secret-manager.interface';
import {
  BILLING_PROVIDER,
  DisabledBillingProvider,
  type BillingProvider,
  type BillingProviderKey,
} from './billing-provider';
import {
  RAZORPAY_BILLING_CREDENTIALS,
  STRIPE_BILLING_CREDENTIALS,
  assertUsableKey,
  credentialConfigured,
  resolveCredential,
} from './billing-credentials';
import { StripeBillingProvider } from './stripe-billing.provider';
import { RazorpaySubscriptionsProvider } from './razorpay-subscriptions.provider';

/** Billing follows the ORGANIZER's country. One provider per country; no fallback between them. */
export const BILLING_PROVIDER_BY_COUNTRY: Readonly<Record<string, BillingProviderKey>> = {
  US: 'STRIPE_BILLING',
  IN: 'RAZORPAY_BILLING',
};

type RealKey = 'STRIPE_BILLING' | 'RAZORPAY_BILLING';

/**
 * Which billing provider serves an account, built on first use.
 *
 * BILLING_PROVIDER=disabled or mock: every country gets the one BILLING_PROVIDER instance (the
 * disabled provider, or the test double). BILLING_PROVIDER=providers: US gets Stripe Billing,
 * IN gets Razorpay Subscriptions, any other country the disabled provider.
 *
 * Real providers are built lazily because their credentials may be secret REFERENCES resolved
 * through the secret manager, which is asynchronous. A failed build is not cached: fixing the
 * configuration and retrying works without a restart. Nothing here is shared with the ticket
 * payment provider factory - only the secret manager and the key-safety rules are reused.
 */
@Injectable()
export class BillingProviderRegistry {
  private readonly logger = new Logger('BillingProviders');
  private readonly built = new Map<RealKey, Promise<BillingProvider>>();
  private readonly disabled = new DisabledBillingProvider();
  private readonly overrides = new Map<BillingProviderKey, BillingProvider>();

  constructor(
    private readonly config: ConfigService,
    @Inject(BILLING_PROVIDER) private readonly fallback: BillingProvider,
    @Optional() @Inject(SECRET_MANAGER) private readonly secrets: SecretManager | null = null,
  ) {}

  /**
   * A registry that answers with fixed providers (tests). With `byKey` it routes by country
   * like BILLING_PROVIDER=providers, to the instances given.
   */
  static fixed(
    provider: BillingProvider,
    byKey: Partial<Record<BillingProviderKey, BillingProvider>> = {},
  ): BillingProviderRegistry {
    const mode = Object.keys(byKey).length > 0 ? 'providers' : 'fixed';
    const r = new BillingProviderRegistry(
      { get: (k: string) => (k === 'BILLING_PROVIDER' ? mode : undefined) } as never,
      provider,
      null,
    );
    for (const [k, p] of Object.entries(byKey)) r.overrides.set(k as BillingProviderKey, p!);
    return r;
  }

  private mode(): string {
    return this.config.get<string>('BILLING_PROVIDER') ?? 'disabled';
  }

  /** The provider key that would serve this country, without building anything. */
  keyForCountry(country: string | null | undefined): BillingProviderKey {
    if (this.mode() !== 'providers') return this.fallback.key;
    return (country && BILLING_PROVIDER_BY_COUNTRY[country]) || 'NONE';
  }

  /** Whether this country could pay here: a provider with credentials configured (no lookup). */
  configuredFor(country: string | null | undefined): boolean {
    const key = this.keyForCountry(country);
    if (this.overrides.has(key)) return this.overrides.get(key)!.enabled;
    if (this.mode() !== 'providers') return this.fallback.enabled;
    if (key === 'STRIPE_BILLING') {
      return (
        credentialConfigured(this.config, STRIPE_BILLING_CREDENTIALS.secretKey) &&
        credentialConfigured(this.config, STRIPE_BILLING_CREDENTIALS.webhookSecret)
      );
    }
    if (key === 'RAZORPAY_BILLING') {
      return Object.values(RAZORPAY_BILLING_CREDENTIALS).every((c) =>
        credentialConfigured(this.config, c),
      );
    }
    return false;
  }

  async forCountry(country: string | null | undefined): Promise<BillingProvider> {
    return this.byKey(this.keyForCountry(country));
  }

  async byKey(key: BillingProviderKey): Promise<BillingProvider> {
    const override = this.overrides.get(key);
    if (override) return override;
    if (this.mode() !== 'providers') {
      return key === this.fallback.key ? this.fallback : this.disabled;
    }
    if (key !== 'STRIPE_BILLING' && key !== 'RAZORPAY_BILLING') return this.disabled;
    let pending = this.built.get(key);
    if (!pending) {
      pending = this.build(key).catch((err) => {
        this.built.delete(key);
        // The message names variables only (billing-credentials.ts); never a value.
        this.logger.error(`Could not build ${key}: ${(err as Error).message}`);
        throw new AppException(
          ErrorCodes.BILLING_PROVIDER_UNAVAILABLE,
          'Paying for a plan is not available right now. Contact ETicketsGo support.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      });
      this.built.set(key, pending);
    }
    return pending;
  }

  private async build(key: RealKey): Promise<BillingProvider> {
    const appEnv = this.config.get<string>('APP_ENV') ?? 'LOCAL';
    const need = async (spec: { name: string; fallback?: string }) => {
      const v = await resolveCredential(this.config, this.secrets, spec);
      if (!v) throw new Error(`${spec.name} is not configured.`);
      return v;
    };
    if (key === 'STRIPE_BILLING') {
      const c = STRIPE_BILLING_CREDENTIALS;
      const secretKey = await need(c.secretKey);
      const mode = assertUsableKey(c.secretKey.name, secretKey, 'stripe', appEnv);
      return new StripeBillingProvider({
        secretKey,
        webhookSecret: await need(c.webhookSecret),
        mode,
        apiVersion: this.config.get<string>('STRIPE_API_VERSION') || undefined,
      });
    }
    const c = RAZORPAY_BILLING_CREDENTIALS;
    const keyId = await need(c.keyId);
    const mode = assertUsableKey(c.keyId.name, keyId, 'razorpay', appEnv);
    return new RazorpaySubscriptionsProvider({
      keyId,
      keySecret: await need(c.keySecret),
      webhookSecret: await need(c.webhookSecret),
      mode,
      mandateMaxMinor: Number(this.config.get('RAZORPAY_BILLING_MANDATE_MAX_MINOR') ?? 1_500_000),
      upiAutopay: String(this.config.get('RAZORPAY_BILLING_UPI_AUTOPAY')) === 'true',
    });
  }
}
