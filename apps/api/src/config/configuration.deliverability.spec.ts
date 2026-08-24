import { loadConfig } from './configuration';

/**
 * A production that cannot deliver a ticket must not start.
 *
 * ── THE FAILURE MODE ───────────────────────────────────────────────────────────────
 * `EMAIL_PROVIDER` defaults to `log`, which writes to the service log and sends nothing.
 * That default is correct everywhere a developer runs the app, and catastrophic in
 * production: the platform boots clean, reports healthy, takes the money, and the customer
 * never receives their ticket. The log even records a line that reads like a success.
 *
 * It is invisible to every health check, every smoke test and every unit test — the only
 * party who finds out is the person who paid. So it is refused at boot, like a payment
 * credential. These tests pin that refusal, and pin the escape hatch too, because an
 * escape hatch nobody tests is an escape hatch that silently stops working.
 */
describe('loadConfig deliverability hardening', () => {
  const ORIGINAL = process.env;
  const STRONG = 'a'.repeat(40);

  const base = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    APP_ENV: 'PRODUCTION',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db/x',
    JWT_ACCESS_SECRET: STRONG,
    JWT_REFRESH_SECRET: STRONG,
    QR_SIGNING_SECRET: STRONG,
    PAYMENT_WEBHOOK_SECRET: STRONG,
    CORS_ORIGINS: 'https://app.eticketsgo.com',
    PAYMENT_PROVIDER_NAME: 'stripe',
    ...extra,
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterAll(() => {
    process.env = ORIGINAL;
  });

  it('refuses to boot production on the log transport', () => {
    process.env = base();
    expect(() => loadConfig()).toThrow(/SENDS NOTHING/);
  });

  it('says what would happen, not just that a variable is wrong', () => {
    // The message is the whole point. Somebody reading a crashed boot at 2am needs to know
    // that customers would be charged and get nothing, not that an enum has a bad value.
    process.env = base();
    expect(() => loadConfig()).toThrow(/never receive a ticket/);
    expect(() => loadConfig()).toThrow(/EMAIL_PROVIDER=sendgrid or ses/);
  });

  it('refuses a real provider with no sender address', () => {
    // SendGrid and SES both reject a send with no From. Catching it at boot turns a
    // per-message runtime failure into one clear startup error.
    process.env = base({ EMAIL_PROVIDER: 'sendgrid' });
    expect(() => loadConfig()).toThrow(/EMAIL_FROM is required/);
  });

  it.each(['sendgrid', 'ses'])('boots with %s configured', (provider) => {
    process.env = base({ EMAIL_PROVIDER: provider, EMAIL_FROM: 'tickets@eticketsgo.com' });
    expect(() => loadConfig()).not.toThrow();
  });

  it('applies to STAGING as well, because staging serves real rehearsal traffic', () => {
    process.env = base({ APP_ENV: 'STAGING' });
    expect(() => loadConfig()).toThrow(/SENDS NOTHING/);
  });

  it('leaves lower environments alone EVEN THOUGH they run NODE_ENV=production', () => {
    /*
      The regression this pins. QA and UAT both deploy with NODE_ENV=production — they
      serve production builds, which is their whole purpose. An earlier version of this
      guard reused the `isProdLike` test the security checks use (NODE_ENV OR APP_ENV) and
      would have refused to boot both of them for having a log mail transport, which is
      exactly the transport they are supposed to have: their bookings are test bookings,
      and mailing real inboxes is the failure there.

      NODE_ENV is deliberately left at 'production' here. Setting it to 'development' would
      make this test pass against the broken guard too, and prove nothing.
    */
    for (const appEnv of ['LOCAL', 'DEV', 'QA', 'UAT']) {
      process.env = base({ APP_ENV: appEnv, NODE_ENV: 'production' });
      expect(() => loadConfig()).not.toThrow();
    }
  });

  it('honours the escape hatch, and only when typed out exactly', () => {
    // For migrations and smoke checks against an environment whose mail provider is not
    // live yet. Anything other than the exact string 'true' must not disarm the guard —
    // a typo that quietly opens a safety control is worse than no control.
    process.env = base({ ALLOW_UNDELIVERABLE_NOTIFICATIONS: 'true' });
    expect(() => loadConfig()).not.toThrow();

    for (const value of ['false', 'TRUE', 'yes', '1']) {
      process.env = base({ ALLOW_UNDELIVERABLE_NOTIFICATIONS: value });
      // 'TRUE'/'yes'/'1' are not members of the declared enum, so the schema rejects them
      // outright; 'false' passes the schema and is then caught by the guard. Either way
      // the environment does not boot, which is the property that matters.
      expect(() => loadConfig()).toThrow();
    }
  });

  it('does not weaken the existing production hardening', () => {
    // Adding a guard must not accidentally short-circuit the ones already there.
    process.env = base({
      EMAIL_PROVIDER: 'sendgrid',
      EMAIL_FROM: 'tickets@eticketsgo.com',
      JWT_ACCESS_SECRET: 'changeme',
    });
    expect(() => loadConfig()).toThrow(/Insecure production configuration/);
  });
});
