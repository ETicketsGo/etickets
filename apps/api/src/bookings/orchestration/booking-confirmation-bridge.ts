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
@Injectable()
export class BookingConfirmationBridge {
  private readonly logger = new Logger('BookingConfirmationBridge');
  private handler?: (bookingId: string) => Promise<void>;

  register(handler: (bookingId: string) => Promise<void>): void {
    this.handler = handler;
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
}

@Global()
@Module({
  providers: [BookingConfirmationBridge],
  exports: [BookingConfirmationBridge],
})
export class BookingConfirmationBridgeModule {}
