import { Injectable } from '@nestjs/common';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import type { ProviderTransferReader } from './transfer-reconciliation';

/**
 * Hands out the single provider capability transfer observation is allowed: one read.
 *
 * ── WHY THIS CLASS EXISTS AT ALL ───────────────────────────────────────────────────────
 * The observation worker is typed to accept only a `ProviderTransferReader`, and that type is
 * the proof it cannot move money. But a worker has to GET a reader from somewhere, and the
 * obvious way - inject `PaymentProviderRegistry` and call `.get(name)` - puts a full adapter one
 * property access away from an automated loop over unresolved payouts. The type-level proof
 * would then protect only the function signature, not the dependency graph.
 *
 * This is the same narrowing `ReconciliationReaderRegistry` does for reversals, applied to the
 * side that sends the organizer's whole payout out.
 *
 * ── WHY THE REGISTRY IS NOT STORED ON A FIELD ──────────────────────────────────────────
 * `private readonly registry` is private to TypeScript and fully reachable at runtime, so
 * `worker.readers.registry.get('razorpay').createTransfer` would be a real path. The constructor
 * captures the lookup in a closure and keeps no reference to the registry, so no property chain
 * leads from the worker to anything that can move money.
 *
 * ── TODAY IT RETURNS NULL FOR EVERYTHING ───────────────────────────────────────────────
 * No adapter implements `getTransferState`, which is a fact about the providers and not about
 * this class. A provider that cannot be read is not an error and not a reason to guess: it
 * yields no reader, and reconciliation records CANNOT_BE_ASKED.
 */
@Injectable()
export class TransferReaderRegistry {
  /** Closed over the registry. Not a field, so the registry is not reachable from here. */
  private readonly lookup: (name: string) => ProviderTransferReader | null;

  constructor(registry: PaymentProviderRegistry) {
    this.lookup = (name: string): ProviderTransferReader | null => {
      const provider = registry.get(name);
      if (!provider || typeof provider.getTransferState !== 'function') return null;

      // A fresh object with exactly one method. Nothing else is on its surface.
      return {
        getTransferState: (lookup) => provider.getTransferState!(lookup),
      };
    };
  }

  /** A one-method reader for this provider, or null if its transfers cannot be read. */
  for(providerName: string): ProviderTransferReader | null {
    return this.lookup(providerName);
  }
}
