import type {
  WalletPassMode,
  WalletPassProjection,
  WalletProvider,
  WalletProviderStatus,
} from '@eticketsgo/shared-types';
import type { ResolvedWalletConfig } from '../wallet-config.service';

/**
 * The pass descriptor a provider produces from a valid ticket. It is a NON-SECRET
 * projection (barcode = the existing signed QR token, event/seat/holder fields). In
 * sandbox mode it is not signed into an installable pass — that requires production
 * signing material, documented as an external dependency.
 */
export interface WalletPassResult {
  provider: WalletProvider;
  status: WalletProviderStatus;
  mode: WalletPassMode;
  descriptor: Record<string, unknown>;
  note: string;
}

/** A wallet provider adapter. Environment-based; never embeds secret material. */
export interface WalletPassProvider {
  readonly kind: WalletProvider;
  /** Builds a pass descriptor from a valid ticket projection (caller checks status). */
  build(cfg: ResolvedWalletConfig, projection: WalletPassProjection): WalletPassResult;
}
