import { Global, Injectable, Logger, Module } from '@nestjs/common';

/**
 * One-way bridge from the payment confirmation path to the booking orchestrator (ADR-042
 * §10, P5.2A). The webhook confirmation stays authoritative and atomic in PaymentsService;
 * AFTER it commits, it notifies the orchestrator so the durable BookingWorkflow advances to
 * CONFIRMED. Using a registration bridge (both sides depend on THIS, not on each other)
 * avoids a PaymentsService↔Orchestrator DI cycle while keeping the orchestrator the single
 * workflow decision point. When no handler is registered (orchestrator disabled / not
 * wired), every call is a safe no-op. It never throws into the confirmation path.
 */
/** A verified payment success fact, passed to the pre-confirmation hook. */
export interface VerifiedPaymentFact {
  bookingId: string;
  providerRef: string;
  amountMinor: number;
}

/**
 * Result of the pre-confirmation hook. `handled: true` means a provider-authoritative flow
 * took ownership of confirmation (provider-confirm → local-confirm, or an ambiguous/deferred
 * outcome) and PaymentsService must NOT run its default local confirm. `handled: false`
 * (or no hook) means the standard local/allocated confirm proceeds unchanged.
 */
export interface PreConfirmResult {
  handled: boolean;
  result?: unknown;
}

@Injectable()
export class BookingConfirmationBridge {
  private readonly logger = new Logger('BookingConfirmationBridge');
  private handler?: (bookingId: string) => Promise<void>;
  private preConfirmHandler?: (fact: VerifiedPaymentFact) => Promise<PreConfirmResult>;
  private providerCancelHandler?: (bookingId: string) => Promise<string>;

  register(handler: (bookingId: string) => Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Register the provider-authoritative pre-confirmation handler (ADR-042 §10, P5.2B S3).
   * Runs BEFORE the default local confirm so provider confirmation can gate it. Only the
   * provider strategy registers this; the local/allocated path leaves it unset.
   */
  registerPreConfirm(handler: (fact: VerifiedPaymentFact) => Promise<PreConfirmResult>): void {
    this.preConfirmHandler = handler;
  }

  /**
   * Give a provider-authoritative flow the chance to own confirmation for this booking. When
   * no handler is registered, or it declines (`handled: false`), the default local confirm
   * proceeds. Never throws into the payment path.
   */
  async preConfirm(fact: VerifiedPaymentFact): Promise<PreConfirmResult> {
    if (!this.preConfirmHandler) return { handled: false };
    try {
      return await this.preConfirmHandler(fact);
    } catch (err) {
      // A provider pre-confirm failure must not silently confirm locally; surface it so the
      // payment path returns an error the provider webhook can retry, and it is reconcilable.
      this.logger.error(`provider pre-confirm failed for booking=${fact.bookingId}`, err as Error);
      throw err;
    }
  }

  async onConfirmed(bookingId: string): Promise<void> {
    if (!this.handler) return;
    try {
      await this.handler(bookingId);
    } catch (err) {
      // Post-commit reconciliation is best-effort; a failure here is picked up by
      // reconciliation and must never fail an already-confirmed payment.
      this.logger.error(
        `workflow confirm-sync bridge failed for booking=${bookingId}`,
        err as Error,
      );
    }
  }

  /**
   * Register the Phase-4 provider RESERVATION cancellation handler (ADR-043, P5.3B). The
   * provider strategy owns the eligibility + idempotent provider call + event emission; the
   * compensation worker invokes it. Only the provider strategy registers this.
   */
  registerProviderCancel(handler: (bookingId: string) => Promise<string>): void {
    this.providerCancelHandler = handler;
  }

  /** Invoke the provider reservation cancellation handler; 'NO_HANDLER' if unwired. */
  async cancelProviderReservation(bookingId: string): Promise<string> {
    if (!this.providerCancelHandler) return 'NO_HANDLER';
    return this.providerCancelHandler(bookingId);
  }
}

@Global()
@Module({
  providers: [BookingConfirmationBridge],
  exports: [BookingConfirmationBridge],
})
export class BookingConfirmationBridgeModule {}
