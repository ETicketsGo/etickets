import { Injectable } from '@nestjs/common';
import { PaymentProviderRegistry } from '../orchestration/provider-registry';
import type { ProviderReconciliationReader } from './reversal-sweeper';

/**
 * Hands out the single provider capability a reconciliation sweep is allowed: one read.
 *
 * ── WHY THIS CLASS EXISTS AT ALL ───────────────────────────────────────────────────
 * The sweeper is already typed to accept only a `ProviderReconciliationReader`, and that type
 * is the proof that it cannot move money. But a scheduled runner has to GET a reader from
 * somewhere, and the obvious way - inject `PaymentProviderRegistry` and call `.get(name)` - puts
 * a full adapter one property access away from the sweep. The type-level proof then protects
 * only the function signature, not the dependency graph, and the next person to add a line to
 * the runner has `createTransfer` within reach.
 *
 * So the registry is narrowed HERE and the sweep service never sees the payment registry.
 *
 * ── WHY THE REGISTRY IS NOT STORED ON A FIELD ──────────────────────────────────────
 * `private readonly registry` would be private to TypeScript and fully reachable at runtime -
 * `service.readers.registry.get('razorpay').createTransfer` is a real path, and `private` is a
 * compile-time courtesy, not a boundary. The constructor therefore captures the lookup in a
 * closure and keeps no reference to the registry itself, so there is no property chain from the
 * runner to anything that can move money.
 *
 * ── WHAT THE TESTS DO AND DO NOT COVER ─────────────────────────────────────────────
 * `reversal-reconciliation.service.spec.ts` asserts this two ways, and they catch different
 * mistakes:
 *
 *   - "does not expose the provider registry" fails if the registry is stored on a field. It is
 *     what actually catches the broadening this class exists to prevent, verified by making that
 *     exact edit and watching it fail.
 *   - the graph walk fails if a forbidden method is reachable by property access from the
 *     service. It did NOT catch the stored-field edit, because a registry reached through a
 *     `get()` call is behind a function rather than a property - so the walk is a backstop, not
 *     the proof. Stated here so nobody over-trusts it.
 *
 * Neither can stop somebody injecting `PaymentProviderRegistry` into a NEW service and calling
 * it directly. Nothing short of a lint rule can, and the honest position is that this narrows
 * the one scheduled path that exists rather than the whole codebase.
 */
@Injectable()
export class ReconciliationReaderRegistry {
  /** Closed over the registry. Not a field, so the registry is not reachable from here. */
  private readonly lookup: (name: string) => ProviderReconciliationReader | null;

  constructor(registry: PaymentProviderRegistry) {
    this.lookup = (name: string): ProviderReconciliationReader | null => {
      const provider = registry.get(name);
      /*
        `getTransferReversalState` is optional on the provider interface: the mock and some
        adapters do not implement it. A provider that cannot be READ is not an error and not a
        reason to guess - it simply yields no reader, and the sweep records NO_REFERENCE rather
        than concluding anything about the money.
      */
      if (!provider || typeof provider.getTransferReversalState !== 'function') return null;

      // A fresh object with exactly one method. Nothing else is on its surface.
      return {
        getTransferReversalState: (transferId: string) =>
          provider.getTransferReversalState!(transferId),
      };
    };
  }

  /** A one-method reader for this provider, or null if its reversals cannot be read. */
  for(providerName: string): ProviderReconciliationReader | null {
    return this.lookup(providerName);
  }
}
