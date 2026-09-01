import { redirectUrl } from './console-urls';

/**
 * The rule that ends this platform's most repeated bug: a URL a human is redirected to
 * must never quietly be localhost in a deployed environment.
 *
 * Three of these shipped and failed in a real environment — invite links, the password
 * reset, and the Razorpay callback, which would have returned a paying customer to a
 * laptop after the money moved. These tests are written against that failure, not against
 * the happy path.
 */
const cfg = (values: Record<string, string | undefined>) =>
  ({ get: (k: string) => values[k] }) as never;

describe('redirectUrl', () => {
  const opts = {
    overrideVariable: 'STRIPE_SUCCESS_URL',
    site: 'customer' as const,
    path: '/checkout/success',
    purpose: 'Stripe Checkout success',
  };

  it('derives from the site variable that already knows where the storefront is', () => {
    expect(redirectUrl(cfg({ CUSTOMER_WEB_URL: 'https://qa.eticketsgo.com' }), opts)).toBe(
      'https://qa.eticketsgo.com/checkout/success',
    );
  });

  it('does not double the slash when the origin has a trailing one', () => {
    expect(redirectUrl(cfg({ CUSTOMER_WEB_URL: 'https://qa.eticketsgo.com/' }), opts)).toBe(
      'https://qa.eticketsgo.com/checkout/success',
    );
  });

  it('passes a provider placeholder through verbatim', () => {
    // Stripe substitutes {CHECKOUT_SESSION_ID} itself. Encoding it would break the redirect.
    const url = redirectUrl(cfg({ CUSTOMER_WEB_URL: 'https://qa.eticketsgo.com' }), {
      ...opts,
      query: 'session_id={CHECKOUT_SESSION_ID}',
    });
    expect(url).toBe('https://qa.eticketsgo.com/checkout/success?session_id={CHECKOUT_SESSION_ID}');
  });

  it('lets an explicit override win, for a return that is not the obvious site', () => {
    expect(
      redirectUrl(
        cfg({
          CUSTOMER_WEB_URL: 'https://qa.eticketsgo.com',
          STRIPE_SUCCESS_URL: 'https://partner.example/thanks',
        }),
        opts,
      ),
    ).toBe('https://partner.example/thanks');
  });

  it('THROWS rather than returning localhost in a deployed environment', () => {
    /*
      The whole point. A default is not a missing value: nothing is unset, so nothing
      complains, and the failure surfaces as a customer staring at a dead tab after paying.
      Refusing to start the payment is strictly better than taking the money and losing them.
    */
    expect(() => redirectUrl(cfg({ APP_ENV: 'QA' }), opts)).toThrow(/CUSTOMER_WEB_URL/);
    expect(() => redirectUrl(cfg({ APP_ENV: 'PRODUCTION' }), opts)).toThrow(/localhost/);
  });

  it('keys the escape on APP_ENV, not NODE_ENV', () => {
    // QA and UAT both run with NODE_ENV=production on this platform, so a guard reading
    // NODE_ENV would be answering a different question than the one being asked.
    expect(() => redirectUrl(cfg({ APP_ENV: 'UAT', NODE_ENV: 'development' }), opts)).toThrow();
  });

  it('still allows localhost on a developer machine', () => {
    expect(redirectUrl(cfg({ APP_ENV: 'LOCAL' }), opts)).toBe(
      'http://localhost:3000/checkout/success',
    );
    expect(redirectUrl(cfg({}), opts)).toBe('http://localhost:3000/checkout/success');
  });

  it('sends an organizer back to the organizer console, not the storefront', () => {
    // Getting this wrong drops somebody half-way through Stripe onboarding onto a page
    // that knows nothing about it.
    expect(
      redirectUrl(cfg({ ORGANIZER_WEB_URL: 'https://organizer-qa.eticketsgo.com' }), {
        overrideVariable: 'STRIPE_CONNECT_RETURN_URL',
        site: 'organizer',
        path: '/organizer/payouts',
        query: 'onboarding=return',
        purpose: 'Stripe Connect onboarding return',
      }),
    ).toBe('https://organizer-qa.eticketsgo.com/organizer/payouts?onboarding=return');
  });

  it('names the missing variable and the journey, so the message is actionable', () => {
    expect(() =>
      redirectUrl(cfg({ APP_ENV: 'QA' }), {
        overrideVariable: 'STRIPE_CONNECT_RETURN_URL',
        site: 'organizer',
        path: '/organizer/payouts',
        purpose: 'Stripe Connect onboarding return',
      }),
    ).toThrow(/ORGANIZER_WEB_URL.*STRIPE_CONNECT_RETURN_URL|Stripe Connect onboarding return/);
  });
});
