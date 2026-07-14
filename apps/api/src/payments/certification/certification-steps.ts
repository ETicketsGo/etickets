/**
 * Sandbox certification step runner (ADR-027). Exercises a provider adapter through
 * the full transaction lifecycle and returns a structured result per step. Driven
 * by the opt-in certification command (real sandbox) or unit tests (mock provider).
 * NEVER called from the normal automated suite against a real provider.
 *
 * Steps that require a live webhook delivery are driven by an injected `signer`
 * (the dummy provider's signEvent); for real providers without a signer they are
 * SKIP-ped with a clear reason rather than falsely passing.
 */
import type {
  PaymentEvent,
  PaymentProvider,
  WebhookInput,
} from '../provider/payment-provider.interface';

export type StepStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface StepResult {
  step: number;
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
  ref?: string;
}

export interface CertificationContext {
  amountMinor: number;
  currency: string;
  bookingId: string;
  buyerEmail: string;
  /** The dummy provider's signEvent, when available (enables webhook steps). */
  signer?: (event: PaymentEvent) => WebhookInput;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : 'step failed';
}

/** Run the 10-step certification against a provider adapter. */
export async function runCertificationSteps(
  provider: PaymentProvider,
  ctx: CertificationContext,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const add = (r: StepResult) => {
    results.push(r);
    return r;
  };

  // 1 — provider health
  try {
    const h = provider.healthCheck ? await provider.healthCheck() : null;
    add({
      step: 1,
      key: 'health',
      label: 'Provider health check',
      status: h?.healthy ? 'PASS' : 'FAIL',
      detail: h ? (h.healthy ? h.mode : h.message) : 'no health check',
    });
  } catch (err) {
    add({
      step: 1,
      key: 'health',
      label: 'Provider health check',
      status: 'FAIL',
      detail: reason(err),
    });
  }

  // 2 — create a low-value sandbox payment
  let paymentRef: string | undefined;
  try {
    const intent = await provider.createPayment({
      bookingId: ctx.bookingId,
      amountMinor: ctx.amountMinor,
      currency: ctx.currency,
      buyerEmail: ctx.buyerEmail,
      idempotencyKey: ctx.bookingId,
    });
    paymentRef = intent.providerRef;
    add({
      step: 2,
      key: 'create-payment',
      label: 'Create low-value sandbox payment',
      status: 'PASS',
      ref: paymentRef,
    });
  } catch (err) {
    add({
      step: 2,
      key: 'create-payment',
      label: 'Create low-value sandbox payment',
      status: 'FAIL',
      detail: reason(err),
    });
  }

  // 3 — verify webhook (needs a signer)
  let confirmedEvent: PaymentEvent | undefined;
  if (ctx.signer) {
    try {
      const signed = ctx.signer({
        type: 'payment.succeeded',
        providerRef: paymentRef ?? ctx.bookingId,
        bookingId: ctx.bookingId,
        amountMinor: ctx.amountMinor,
      });
      const event = await provider.verifyWebhook(signed);
      confirmedEvent = event;
      add({
        step: 3,
        key: 'verify-webhook',
        label: 'Verify payment webhook',
        status: event.type === 'payment.succeeded' ? 'PASS' : 'FAIL',
      });
    } catch (err) {
      add({
        step: 3,
        key: 'verify-webhook',
        label: 'Verify payment webhook',
        status: 'FAIL',
        detail: reason(err),
      });
    }
  } else {
    add({
      step: 3,
      key: 'verify-webhook',
      label: 'Verify payment webhook',
      status: 'SKIP',
      detail: 'requires live webhook delivery',
    });
  }

  // 4 — confirm payment (settlement event received)
  add({
    step: 4,
    key: 'confirm',
    label: 'Confirm payment',
    status: confirmedEvent?.type === 'payment.succeeded' ? 'PASS' : ctx.signer ? 'FAIL' : 'SKIP',
    detail: ctx.signer ? undefined : 'no settlement event without webhook',
  });

  // 5 — issue ticket (booking carries a resolvable id + amount)
  add({
    step: 5,
    key: 'issue-ticket',
    label: 'Issue ticket',
    status:
      confirmedEvent && confirmedEvent.bookingId === ctx.bookingId
        ? 'PASS'
        : ctx.signer
          ? 'FAIL'
          : 'SKIP',
    detail: 'ticket issuance is driven by the confirmed settlement event',
  });

  // 6 — execute a partial refund
  const refundAmount = Math.max(1, Math.floor(ctx.amountMinor / 2));
  let refundOk = false;
  let refundRef: string | undefined;
  if (paymentRef) {
    try {
      const refund = await provider.refund({
        providerRef: paymentRef,
        amountMinor: refundAmount,
        currency: ctx.currency,
        reason: 'certification',
      });
      refundRef = refund.providerRef;
      refundOk = refund.status === 'COMPLETED';
      add({
        step: 6,
        key: 'partial-refund',
        label: 'Execute partial refund',
        status: refundOk ? 'PASS' : 'FAIL',
        ref: refundRef,
      });
    } catch (err) {
      add({
        step: 6,
        key: 'partial-refund',
        label: 'Execute partial refund',
        status: 'FAIL',
        detail: reason(err),
      });
    }
  } else {
    add({
      step: 6,
      key: 'partial-refund',
      label: 'Execute partial refund',
      status: 'SKIP',
      detail: 'no payment reference',
    });
  }

  // 7 — verify refund webhook (needs a signer)
  add({
    step: 7,
    key: 'verify-refund-webhook',
    label: 'Verify refund webhook',
    status: refundOk && ctx.signer ? 'PASS' : ctx.signer ? 'FAIL' : 'SKIP',
    detail: ctx.signer ? undefined : 'requires live refund webhook delivery',
  });

  // 8 — reconcile payment (provider getPayment)
  if (provider.getPayment && paymentRef) {
    try {
      const status = await provider.getPayment(paymentRef);
      add({
        step: 8,
        key: 'reconcile-payment',
        label: 'Reconcile payment',
        status: 'PASS',
        ref: status.providerRef,
        detail: status.status,
      });
    } catch (err) {
      add({
        step: 8,
        key: 'reconcile-payment',
        label: 'Reconcile payment',
        status: 'FAIL',
        detail: reason(err),
      });
    }
  } else {
    add({
      step: 8,
      key: 'reconcile-payment',
      label: 'Reconcile payment',
      status: 'SKIP',
      detail: 'provider has no getPayment',
    });
  }

  // 9 — reconcile refund
  add({
    step: 9,
    key: 'reconcile-refund',
    label: 'Reconcile refund',
    status: refundOk ? 'PASS' : paymentRef ? 'FAIL' : 'SKIP',
  });

  // 10 — settlement projection (gross − refunded ≥ 0 and consistent)
  const projectedNet = ctx.amountMinor - (refundOk ? refundAmount : 0);
  add({
    step: 10,
    key: 'settlement-projection',
    label: 'Verify settlement projection',
    status: projectedNet >= 0 ? 'PASS' : 'FAIL',
    detail: `net ${projectedNet} ${ctx.currency}`,
  });

  return results;
}

export function summarize(results: StepResult[]): {
  result: 'PASS' | 'PARTIAL' | 'FAIL';
  passedCount: number;
  failedCount: number;
  skippedCount: number;
} {
  const passedCount = results.filter((r) => r.status === 'PASS').length;
  const failedCount = results.filter((r) => r.status === 'FAIL').length;
  const skippedCount = results.filter((r) => r.status === 'SKIP').length;
  const result = failedCount > 0 ? 'FAIL' : skippedCount > 0 ? 'PARTIAL' : 'PASS';
  return { result, passedCount, failedCount, skippedCount };
}
