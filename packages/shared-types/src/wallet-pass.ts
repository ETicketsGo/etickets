// Wallet-pass projection + provider-config policy (ADR-035 / wallet sandbox). Pure and
// framework-free so it is unit-testable and shared by the API + clients. A wallet pass
// is a PROJECTION of an existing valid ticket — never a separate source of truth — and
// this layer fails closed: an ineligible ticket or an unconfigured provider yields no
// valid current pass, and no secret material is ever represented here.

export type WalletProvider = 'apple' | 'google';

/**
 * A provider is `unavailable` unless it is explicitly enabled AND its required
 * (non-secret) configuration is present. `sandbox` produces test descriptors without
 * real signing material; `configured` (production) additionally requires resolvable
 * signing material and is the only state that can mint an installable pass.
 */
export type WalletProviderStatus = 'unavailable' | 'sandbox' | 'configured';

export type WalletPassMode = 'sandbox' | 'production';

/** Only a live, valid ticket projects to a valid current pass. */
export const WALLET_ELIGIBLE_STATUSES = ['ACTIVE'] as const;

export function walletPassEligible(ticketStatus: string): boolean {
  return (WALLET_ELIGIBLE_STATUSES as readonly string[]).includes(ticketStatus);
}

/** Safe, non-secret ticket data used to build a pass (mirrors the ticket projection). */
export interface WalletPassProjection {
  ticketId: string;
  serial: string;
  eventTitle: string;
  startsAt: string;
  holderName: string | null;
  ticketType: string;
  seatLabel: string | null;
  venueName: string | null;
  bookingRef: string;
  /** The existing signed QR token — the pass barcode is the SAME token, not a new one. */
  qrToken: string;
}

/**
 * Non-secret provider configuration. Secret material (certs, service-account keys) is
 * NEVER represented here — only whether a *reference* to it is present
 * (`hasSigningMaterial`), so this object can be reasoned about + tested without secrets.
 */
export interface WalletProviderConfig {
  enabled: boolean;
  mode: WalletPassMode;
  /** Provider-specific required non-secret fields (e.g. issuer/team/pass-type ids). */
  requiredPresent: boolean;
  /** Whether a reference to real signing material is configured (never the material). */
  hasSigningMaterial: boolean;
}

/**
 * Fail-closed status resolution. Disabled or missing required config → unavailable.
 * Sandbox mode with valid required config → sandbox (test descriptors, no signing).
 * Production mode additionally requires signing material → configured, else unavailable.
 */
export function resolveWalletProviderStatus(cfg: WalletProviderConfig): WalletProviderStatus {
  if (!cfg.enabled || !cfg.requiredPresent) return 'unavailable';
  if (cfg.mode === 'sandbox') return 'sandbox';
  return cfg.hasSigningMaterial ? 'configured' : 'unavailable';
}

/** A provider can mint a (sandbox or real) pass only when not unavailable. */
export function walletProviderCanIssue(status: WalletProviderStatus): boolean {
  return status !== 'unavailable';
}
