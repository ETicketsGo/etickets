import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus } from '@eticketsgo/shared-types';
import { MetricsService } from '../../metrics/metrics.service';
import { PaymentProviderResolver } from '../provider/payment-provider.resolver';
import { PaymentsService } from '../payments.service';
import { verdictFromOrderPayments, type CapturedPaymentVerdict } from './captured-payment-verdict';

/**
 * What the sweep is allowed to do with a lapsed booking.
 *
 * `release` - give the stock back, the ordinary abandoned cart.
 * `recovered` - the provider had the money; the booking went through the canonical
 *   confirmation path instead of being thrown away.
 * `hold_back` - we could not find out. The stock stays held and the next sweep asks again.
 */
export type ExpiryGuardOutcome = 'release' | 'recovered' | 'hold_back';

/** The booking fields the guard needs; a subset of the sweep's candidate rows. */
export interface GuardableBooking {
  id: string;
  payment: { provider: string; status: string; providerOrderId: string | null } | null;
}

/**
 * Stops a captured payment being discarded as an abandoned cart.
 *
 * -- THE INCIDENT ---------------------------------------------------------------------
 * A real UPI payment was captured in production and every webhook delivery was rejected,
 * because the webhook secret did not match. Ten minutes later the hold lapsed and the
 * expiry sweep released the inventory: ETicketsGo held the buyer's money, the booking said
 * EXPIRED, no ticket existed and - worst of all - nothing anywhere recorded that money had
 * been taken. See `docs/incidents/2026-10-06-payment-capture-without-confirmation.md`.
 *
 * The sweep's query is the reason. It selects on `status = PENDING_PAYMENT` and a lapsed
 * `holdExpiresAt`, which cannot distinguish "nobody paid" from "somebody paid and we were
 * not told". The platform already had the right safety net for a capture against an
 * unpayable booking - `recordUnappliedCapture` - but it sits BEHIND webhook signature
 * verification, so a rejected webhook never reaches it.
 *
 * -- WHAT THIS DOES -------------------------------------------------------------------
 * Before the stock goes back, ASK THE PROVIDER - but only when the buyer actually opened
 * the gateway. That gate matters for availability as much as for correctness: a cart
 * abandoned before the payment screen has no order to ask about, so the overwhelming
 * majority of sweeps still make no network call at all, and a provider outage cannot
 * freeze inventory platform-wide.
 *
 * -- WHY IT REUSES processVerifiedEvent -----------------------------------------------
 * Recovery deliberately builds the same `payment.succeeded` event a webhook would and
 * hands it to the same entry point. That is not convenience: it is how exactly-once is
 * inherited rather than reimplemented. `confirm` claims the booking with a conditional
 * update on PENDING_PAYMENT, so a webhook and a recovery racing each other produce one
 * confirmation, one ticket and one set of finance rows - and if the booking can no longer
 * be paid, the SAME path records the unapplied capture for a person to refund. A second
 * fulfillment path here would have to re-earn all of that, and would drift from it.
 */
@Injectable()
export class PendingPaymentRecoveryService {
  private readonly logger = new Logger(PendingPaymentRecoveryService.name);

  constructor(
    private readonly resolver: PaymentProviderResolver,
    private readonly payments: PaymentsService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Does this booking even need asking about? True only once the buyer opened the gateway
   * and a provider order exists to ask about.
   *
   * Kept separate and synchronous so callers that must not make a network call - booking
   * creation, which runs the sweep inline on the hot path - can still recognise the
   * dangerous set and leave it alone instead of releasing it blind.
   */
  needsProviderCheck(booking: GuardableBooking): boolean {
    const p = booking.payment;
    return !!p && p.status === PaymentStatus.PROCESSING && !!p.providerOrderId;
  }

  /**
   * Ask the provider, and act on the answer.
   *
   * Never throws: a guard that throws would abort the whole sweep and strand every other
   * lapsed booking behind one unreachable gateway. An error becomes `hold_back`, which is
   * the safe answer anyway.
   */
  async guardExpiry(booking: GuardableBooking): Promise<ExpiryGuardOutcome> {
    if (!this.needsProviderCheck(booking)) return 'release';
    const payment = booking.payment as NonNullable<GuardableBooking['payment']>;
    const orderId = payment.providerOrderId as string;

    const verdict = await this.classifyOrder(payment.provider, orderId);

    if (verdict.kind === 'none') {
      this.metrics.recordPaymentWebhook?.(payment.provider, 'expiry_no_capture');
      return 'release';
    }

    if (verdict.kind === 'unverifiable') {
      /*
        The stock stays held. An unreleased seat is an inventory delay a person can fix; a
        released seat whose buyer has paid is money taken for nothing, and is not
        recoverable by anyone. The sweep runs every minute, so this resolves itself as soon
        as the provider answers again.
      */
      this.logger.warn(
        `Holding back expiry of booking ${booking.id}: ${payment.provider} order ${orderId} ` +
          `could not be verified (${verdict.reason}). Stock stays held; will retry.`,
      );
      this.metrics.recordPaymentWebhook?.(payment.provider, 'expiry_unverifiable');
      return 'hold_back';
    }

    // Captured. The money is with the provider and we were never told about it.
    this.logger.error(
      `RECOVERING booking ${booking.id}: ${payment.provider} reports order ${orderId} PAID ` +
        `as ${verdict.providerRef} (${verdict.amountMinor} ${verdict.currency}) but no ` +
        `confirmation was received. Routing through the canonical confirmation path.`,
    );
    this.metrics.recordPaymentWebhook?.(payment.provider, 'expiry_capture_recovered');

    try {
      await this.payments.processVerifiedEvent({
        type: 'payment.succeeded',
        bookingId: booking.id,
        providerRef: verdict.providerRef,
        amountMinor: verdict.amountMinor,
      });
    } catch (err) {
      /*
        Recovery failed - an amount disagreement, a cancelled session, anything the confirm
        path refuses. The booking is STILL not released: we know money was captured, and
        that fact outranks tidying up inventory. Left for the next sweep and for a person.
      */
      this.logger.error(
        `Recovery of booking ${booking.id} failed; stock stays held: ${(err as Error).message}`,
      );
      this.metrics.recordPaymentWebhook?.(payment.provider, 'expiry_recovery_failed');
      return 'hold_back';
    }
    return 'recovered';
  }

  /** The provider question, with every failure mode collapsed to `unverifiable`. */
  private async classifyOrder(
    providerName: string,
    orderId: string,
  ): Promise<CapturedPaymentVerdict> {
    let provider: { findOrderPayments?: (id: string) => Promise<unknown> };
    try {
      provider = this.resolver.get(providerName) as never;
    } catch {
      return verdictFromOrderPayments(null, `provider ${providerName} unavailable`);
    }
    if (!provider.findOrderPayments) {
      // An adapter that cannot look an order up can never clear a booking for release.
      return verdictFromOrderPayments(null, `${providerName} cannot look up order payments`);
    }
    try {
      const payments = await provider.findOrderPayments(orderId);
      return verdictFromOrderPayments(payments as never);
    } catch (err) {
      return verdictFromOrderPayments(null, (err as Error).message);
    }
  }
}
