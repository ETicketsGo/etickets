import type { PaymentEnvValue } from '@eticketsgo/web-kit';

/**
 * The payment environment the Payment configuration page shows and edits.
 *
 * The admin's own choice when they have made one; otherwise the environment the API answered
 * for, which is this deployment's active environment because the first request names none.
 * Never a fixed default: the page used to open on LOCAL everywhere, so on UAT it showed a dummy
 * provider while UAT really runs Razorpay. LOCAL is only the placeholder before the first answer,
 * when nothing can be edited yet.
 */
export function paymentConfigEnv(
  chosen: PaymentEnvValue | null,
  data: { env?: PaymentEnvValue; activeEnv?: PaymentEnvValue } | undefined,
): PaymentEnvValue {
  return chosen ?? data?.env ?? data?.activeEnv ?? 'LOCAL';
}
