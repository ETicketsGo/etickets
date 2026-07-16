import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  resolveWalletProviderStatus,
  type WalletPassMode,
  type WalletProvider,
  type WalletProviderConfig,
  type WalletProviderStatus,
} from '@eticketsgo/shared-types';

/** Resolved, non-secret configuration for one wallet provider. */
export interface ResolvedWalletConfig {
  provider: WalletProvider;
  status: WalletProviderStatus;
  mode: WalletPassMode;
  /** Non-secret provider identifiers used to build a pass descriptor. */
  ids: Record<string, string>;
}

/**
 * Reads wallet provider configuration from the environment (typed, fail-closed). It
 * NEVER reads or exposes secret material — only whether a *reference* to signing
 * material is configured (`*_REF`) and non-secret identifiers (issuer/team/pass-type
 * ids). A provider is `unavailable` unless explicitly enabled with valid config.
 */
@Injectable()
export class WalletConfigService {
  constructor(private readonly config: ConfigService) {}

  private mode(raw: string | undefined): WalletPassMode {
    return raw === 'production' ? 'production' : 'sandbox';
  }
  private enabled(key: string): boolean {
    return this.config.get<string>(key) === 'true';
  }

  apple(): ResolvedWalletConfig {
    const passTypeId = this.config.get<string>('WALLET_APPLE_PASS_TYPE_ID') ?? '';
    const teamId = this.config.get<string>('WALLET_APPLE_TEAM_ID') ?? '';
    const cfg: WalletProviderConfig = {
      enabled: this.enabled('WALLET_APPLE_ENABLED'),
      mode: this.mode(this.config.get<string>('WALLET_APPLE_MODE')),
      requiredPresent: !!passTypeId && !!teamId,
      // Reference only — the certificate itself never touches this process/config.
      hasSigningMaterial: !!this.config.get<string>('WALLET_APPLE_CERT_REF'),
    };
    return {
      provider: 'apple',
      status: resolveWalletProviderStatus(cfg),
      mode: cfg.mode,
      ids: { passTypeIdentifier: passTypeId, teamIdentifier: teamId },
    };
  }

  google(): ResolvedWalletConfig {
    const issuerId = this.config.get<string>('WALLET_GOOGLE_ISSUER_ID') ?? '';
    const cfg: WalletProviderConfig = {
      enabled: this.enabled('WALLET_GOOGLE_ENABLED'),
      mode: this.mode(this.config.get<string>('WALLET_GOOGLE_MODE')),
      requiredPresent: !!issuerId,
      hasSigningMaterial: !!this.config.get<string>('WALLET_GOOGLE_SERVICE_ACCOUNT_REF'),
    };
    return {
      provider: 'google',
      status: resolveWalletProviderStatus(cfg),
      mode: cfg.mode,
      ids: { issuerId },
    };
  }

  forProvider(provider: WalletProvider): ResolvedWalletConfig {
    return provider === 'apple' ? this.apple() : this.google();
  }

  /** Non-secret public view (provider + status + mode only). Never returns ids/secrets. */
  publicStatus(): {
    provider: WalletProvider;
    status: WalletProviderStatus;
    mode: WalletPassMode;
  }[] {
    return [this.apple(), this.google()].map((c) => ({
      provider: c.provider,
      status: c.status,
      mode: c.mode,
    }));
  }
}
