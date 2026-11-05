/**
 * Where a hosted checkout opened from the native app sends the buyer back to.
 *
 * The API marks such a return `?via=app` (apps/api stripe-payment.provider `returnUrl`). This
 * page then hands the booking id to the app's own scheme, and the app asks the server what
 * happened: the return itself is never evidence of payment, here or in the app.
 *
 * Not an open redirect: the scheme comes from build configuration and must be one of the
 * app's own (below), the path is fixed, and the only thing carried over is a booking id that
 * looks like one. Unset configuration (production today) means no app return at all.
 */
const APP_SCHEMES = new Set(['etgnative', 'etgnative-qa', 'etgnative-mock']);
const BOOKING_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function appReturnUrl(
  params: { get(name: string): string | null },
  kind: 'return' | 'cancel',
  scheme: string | undefined = process.env.NEXT_PUBLIC_APP_RETURN_SCHEME,
): string | null {
  if (params.get('via') !== 'app' || !scheme || !APP_SCHEMES.has(scheme)) return null;
  const booking = params.get('booking');
  if (!booking || !BOOKING_ID.test(booking)) return null;
  return `${scheme}://checkout/${kind}?booking=${encodeURIComponent(booking)}`;
}
