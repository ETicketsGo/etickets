import { PaymentErrorCode, PaymentProviderError } from '../domain/payment-errors';
import type {
  CreatePaymentInput,
  HealthCheckResult,
  PaymentEvent,
  PaymentIntent,
  PaymentProvider,
  RefundInput,
  RefundResult,
  WebhookInput,
} from './payment-provider.interface';
import type { PaymentProviderCapabilities } from '../domain/payment-capabilities';

/**
 * The gateway we have chosen, before it will take money for us.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * A payment provider needs a live product URL before it will issue live keys, and this platform
 * refuses to run a production storefront on a simulated gateway. Those two are not actually in
 * conflict, but the gap between them had nowhere to live: `PAYMENT_PROVIDER_NAME=razorpay` with no
 * `RAZORPAY_KEY_ID` does not boot, because the adapter demands its credentials in its constructor.
 *
 * Failing at boot is the right default. An operator who configured a gateway and mistyped the key
 * should find out at deploy, not from the first customer who cannot pay. What was missing is the
 * DELIBERATE state: we are open as a catalogue, and payments are not activated yet.
 *
 * So this is not "the provider failed to configure itself". It is a provider that is present,
 * named, and answers every money operation with a refusal - and it is only ever selected when an
 * operator has said in configuration that this is what they want. Inferring it from an absent key
 * would make a typo indistinguishable from a decision; the same reasoning is why a free event
 * DECLARES that it skips payments rather than being guessed at from a zero price.
 *
 * ── WHAT IT GUARANTEES ─────────────────────────────────────────────────────────────
 * Nothing can be charged, and nothing is simulated. Every call throws the same refusal a currency
 * with no route throws, so the storefront already knows how to answer it: the payment step shows
 * that online payment is being activated and that no payment has been taken.
 */
export class UnavailablePaymentProvider implements PaymentProvider {
  readonly webhookSignatureHeader = 'x-payment-signature';

  /*
    Advertises nothing. The routing and orchestration layers read capabilities to decide what may
    be attempted, and a provider that cannot take a payment must not claim it can hold one,
    capture one or refund one.
  */
  readonly capabilities: PaymentProviderCapabilities = {
    countries: [],
    currencies: [],
    paymentMethods: [],
    supportsPartialRefunds: false,
    supportsMultiplePartialRefunds: false,
    supportsAuthorizeCapture: false,
    supportsVoid: false,
    supportsIdempotentVoid: false,
    supportsPaymentStatusQuery: false,
    supportsFullRefund: false,
    supportsIdempotentRefund: false,
    supportsRefundStatusQuery: false,
    refundMayBeAsynchronous: false,
    supportsConnectedAccounts: false,
    supportsApplePay: false,
    supportsGooglePay: false,
    supportsUPI: false,
    supportsNetBanking: false,
    supportsWallets: false,
  };

  /**
   * @param name The gateway this stands in for, so logs, health and the payment row all still say
   *   which provider is being waited on rather than a generic placeholder.
   */
  constructor(readonly name: string) {}

  /*
    A `PaymentProviderError`, and deliberately a NON-RETRYABLE one.

    Two things had to be got right here and neither was visible from reading the code.

    First the type. The exception filter translates a provider error's normalised code into what
    the client sees; an `AppException` thrown from inside a provider never reaches that branch,
    because the orchestrator wraps what it does not recognise. It arrived at the browser as a
    generic `PAYMENT_ERROR`, so the buyer still got the red "Payment failed" this whole change
    exists to stop.

    Then the code. `PROVIDER_UNAVAILABLE` looks like the honest description and is classed
    RETRYABLE - so the orchestrator failed over to the next provider in the chain, which in a
    development chain is the simulated gateway, and the payment SUCCEEDED. A booking was paid for
    by a simulator while the platform was declaring it could not take payments. That is precisely
    the outcome production refuses a mock gateway to prevent, and it returned HTTP 201.

    `AUTHENTICATION_FAILED` is non-retryable and maps to the same `PAYMENT_PROVIDER_UNAVAILABLE`
    the storefront reads. It is also the truth: there are no credentials, so there is nothing to
    authenticate with. Nothing fails over, because there is nothing to fail over from.
  */
  private refuse(): never {
    throw new PaymentProviderError(
      PaymentErrorCode.AUTHENTICATION_FAILED,
      'Online payment is not activated yet.',
      this.name,
    );
  }

  createPayment(_input: CreatePaymentInput): Promise<PaymentIntent> {
    this.refuse();
  }

  /*
    A webhook is refused too, and deliberately so. Nothing we issued can be reported back to us,
    so anything arriving here is either misrouted or forged - and verifying it would mean holding
    the signing secret of a gateway we are not yet using.
  */
  verifyWebhook(_input: WebhookInput): Promise<PaymentEvent> {
    this.refuse();
  }

  refund(_input: RefundInput): Promise<RefundResult> {
    this.refuse();
  }

  async healthCheck(): Promise<HealthCheckResult> {
    /*
      Reported UNHEALTHY on purpose, and not as a fault to be paged on: it is true, it is what the
      readiness screens should show while an application is in progress, and a green tick here
      would say the platform can take money when it cannot. `mode` is 'dummy' because the one
      thing this is certainly not is live.
    */
    return { healthy: false, mode: 'dummy', message: `${this.name}: payments not activated yet` };
  }
}
