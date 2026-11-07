import { routeProviderForBooking } from '@eticketsgo/shared-types';

/**
 * Can this organizer take a PAID order in this currency, right now?
 *
 * The same question `PaymentsService.createIntent` answers at the payment step, asked
 * earlier so nobody meets it with seats in their basket. Found on the 2026-11-07 pilot walk:
 * every US paid event on QA was listed, a buyer reserved seats, and only the payment page
 * said the organizer "cannot take card payments yet" with Pay disabled.
 *
 * It mirrors the payment step exactly, and deliberately no more:
 * - INR routes to Razorpay, which takes the payment on the platform account. No organizer
 *   account is needed there (see `paymentAvailability`), so India is never gated here.
 * - USD/CAD route to Stripe Connect. When this deployment has Stripe keys, the charge is made
 *   for the organizer's connected account, and createIntent refuses without one that has
 *   charges enabled. That is the gate.
 * - A deployment without Stripe keys (local, CI, the mock) has no such refusal at payment,
 *   so it has none here either; whether the platform can take USD at all is a different
 *   answer (`platform_not_configured`), owned by the platform, not the organizer.
 *
 * Returns the provider the organizer still has to finish setting up, or null when paid
 * orders can go ahead.
 */
export interface PaymentReadinessDeps {
  organizerPaymentAccount: {
    findUnique(args: {
      where: { organizationId_provider: { organizationId: string; provider: string } };
      select: { providerAccountId: true; chargesEnabled: true };
    }): Promise<{ providerAccountId: string | null; chargesEnabled: boolean } | null>;
  };
}

export function gatedProviderFor(
  currency: string | null | undefined,
  stripeConfigured: boolean,
): 'stripe' | null {
  if (!currency) return null;
  const name = routeProviderForBooking({ currency });
  return name === 'stripe' && stripeConfigured ? 'stripe' : null;
}

export async function organizerPaymentsGap(
  prisma: PaymentReadinessDeps,
  stripeConfigured: boolean,
  organizationId: string,
  currency: string | null | undefined,
): Promise<'stripe' | null> {
  const provider = gatedProviderFor(currency, stripeConfigured);
  if (!provider) return null;
  const account = await prisma.organizerPaymentAccount.findUnique({
    where: { organizationId_provider: { organizationId, provider } },
    select: { providerAccountId: true, chargesEnabled: true },
  });
  return account?.providerAccountId && account.chargesEnabled ? null : provider;
}

/** The env check the Stripe adapter's own constructor makes (both keys, or it throws). */
export const stripeConfiguredIn = (get: (k: string) => string | undefined): boolean =>
  Boolean(get('STRIPE_SECRET_KEY') && get('STRIPE_WEBHOOK_SECRET'));
