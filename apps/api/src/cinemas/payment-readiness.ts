import {
  isDummyAllowed,
  isLiveAllowed,
  type PaymentEnvName,
} from '../payments/configuration/payment-environment';
import type { ReadinessCheck } from './pilot-readiness';

/**
 * Whether THIS ENVIRONMENT can take the payment a pilot needs.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────
 * Readiness used to answer a different question, badly:
 *
 *     paymentProviderConfigured: Boolean(
 *       process.env.RAZORPAY_KEY_ID || process.env.PAYMENTS_MOCK_MODE === 'true',
 *     )
 *
 * `PAYMENTS_MOCK_MODE` is not a variable this system has. It appears nowhere in the config
 * schema, no `.env`, no CI job and no deploy manifest — its ONLY effect anywhere was to turn
 * this check green. A flag whose sole power is to silence a payment warning is worse than no
 * flag, and it was invented here rather than found.
 *
 * The env var `PAYMENT_PROVIDER` is a similar trap: it is declared in the config schema but
 * read by no runtime code. The switch that actually selects a gateway is
 * `PAYMENT_PROVIDER_NAME`, and that is why a local `PAYMENT_PROVIDER=mock` box could take a
 * mock payment while readiness insisted no payment was possible. Both statements were true
 * about different variables.
 *
 * ── WHAT IT ASKS INSTEAD ──────────────────────────────────────────────────────────
 * The payment module already models all of this: `APP_ENV` resolves to a `PaymentEnvName`,
 * and `isDummyAllowed` / `isLiveAllowed` already encode where a simulated gateway and where
 * real money are permitted. This reuses those predicates rather than inventing a second,
 * disagreeing policy — which is the mistake being corrected.
 *
 * ── THE DISTINCTION THAT MATTERS ──────────────────────────────────────────────────
 * "Payment technically works using a fake provider" is NOT "this environment is ready for an
 * India pilot". A mock gateway confirms every booking it is asked to, which is exactly what
 * makes it useless as evidence. So the mock is fine where it is allowed and says so plainly,
 * and it BLOCKS anywhere a pilot could actually run.
 *
 * Credential VALUES are never read here — only whether a name is set, and the mode the
 * operator declared. Nothing in this file can leak a key into a response or a log.
 */
export interface PaymentReadinessFacts {
  /** Resolved from APP_ENV by the payment module. Unknown values resolve to LOCAL. */
  environment: PaymentEnvName;
  /** The gateway `PAYMENT_PROVIDER_NAME` actually selects. */
  provider: 'mock' | 'razorpay' | 'stripe' | 'paypal' | 'square';
  /** Presence only — never the value. */
  razorpay: {
    hasKeyId: boolean;
    hasKeySecret: boolean;
    hasWebhookSecret: boolean;
    /** The DECLARED mode. Boot validation already refuses a mode that contradicts the key. */
    mode: 'test' | 'live';
  };
  /** The master switch that must be on before any real charge is accepted (ADR-028). */
  liveEnabled: boolean;
}

const block = (code: string, message: string): ReadinessCheck => ({
  section: 'PAYMENTS',
  code,
  level: 'BLOCKED',
  // Every one of these is platform configuration. A theater cannot fix any of it, so none
  // of them offers a route — they name the owner instead.
  message,
  fixPath: null,
});

const warn = (code: string, message: string): ReadinessCheck => ({
  section: 'PAYMENTS',
  code,
  level: 'WARNING',
  message,
  fixPath: null,
});

const ready = (code: string, message: string): ReadinessCheck => ({
  section: 'PAYMENTS',
  code,
  level: 'READY',
  message,
  fixPath: null,
});

export function evaluatePaymentProvider(f: PaymentReadinessFacts): ReadinessCheck[] {
  const env = f.environment;

  if (f.provider === 'mock') {
    /*
      A simulated gateway.

      Allowed in LOCAL, DEV and QA — the same set the payment module already permits it in —
      and it still warns there, because "the booking confirmed" proves nothing about whether
      money can move. Everywhere else it blocks: a pilot rehearsal whose payment step is a
      stub has rehearsed nothing, and reporting READY over it is the specific failure this
      module exists to prevent.
    */
    return isDummyAllowed(env)
      ? [
          warn(
            'PAYMENT_MOCK_ONLY',
            `Payments in ${env} use the simulated gateway: bookings will confirm, but no money moves and nothing here proves a real payment would work. A pilot needs Razorpay sandbox or live credentials.`,
          ),
        ]
      : [
          block(
            'PAYMENT_MOCK_ONLY',
            `${env} is still configured with the simulated payment gateway, so no real payment can be taken. ETicketsGo must configure Razorpay for this environment — contact support.`,
          ),
        ];
  }

  if (f.provider !== 'razorpay') {
    /*
      Stripe, PayPal and Square exist in this codebase for other markets. None of them can
      settle INR for an Indian cinema, and saying so is more useful than a generic refusal.
    */
    return [
      block(
        'PAYMENT_PROVIDER_NOT_INR_CAPABLE',
        `The active payment gateway is ${f.provider}, which cannot settle INR for an Indian cinema. ETicketsGo configures this — contact support.`,
      ),
    ];
  }

  const checks: ReadinessCheck[] = [];
  const missing = [
    !f.razorpay.hasKeyId && 'key ID',
    !f.razorpay.hasKeySecret && 'key secret',
  ].filter(Boolean) as string[];

  if (missing.length > 0) {
    checks.push(
      block(
        'RAZORPAY_NOT_CONFIGURED',
        `Razorpay is selected but its ${missing.join(' and ')} ${
          missing.length === 1 ? 'is' : 'are'
        } not set in ${env}, so no order can be created. ETicketsGo configures this — contact support.`,
      ),
    );
  }

  /*
    The webhook secret is its own check, and its own blocker.

    Razorpay's browser redirect is a hint, not a result — the customer's tab can close, their
    network can drop, and the redirect can be replayed. The webhook is what actually confirms
    a payment server-side, and without a secret its signature cannot be verified, so every
    event would have to be refused. Orders would be created and never confirmed: the worst
    possible failure, because the money leaves the customer.
  */
  if (!f.razorpay.hasWebhookSecret) {
    checks.push(
      block(
        'RAZORPAY_WEBHOOK_NOT_CONFIGURED',
        `Razorpay has no webhook signing secret in ${env}. Payments could be taken but never confirmed, because the confirmation event could not be verified. ETicketsGo configures this — contact support.`,
      ),
    );
  }

  if (f.razorpay.mode === 'test') {
    if (env === 'PRODUCTION') {
      checks.push(
        block(
          'RAZORPAY_TEST_KEYS_IN_PRODUCTION',
          'Production is configured with Razorpay TEST credentials, so no customer would actually be charged. ETicketsGo configures this — contact support.',
        ),
      );
    } else if (checks.length === 0) {
      /*
        Sandbox. This is the intended state for a pilot rehearsal, and it is READY rather than
        a warning: everything a pilot needs to prove — order creation, webhook verification,
        confirmation, refund — is genuinely exercised. It is labelled so nobody mistakes a
        green rehearsal for a live one.
      */
      checks.push(
        ready(
          'RAZORPAY_SANDBOX_READY',
          `Razorpay sandbox (test keys) is configured in ${env}. Real payment mechanics are exercised end to end; no real money moves.`,
        ),
      );
    }
  } else {
    // Declared LIVE.
    if (!isLiveAllowed(env)) {
      checks.push(
        block(
          'RAZORPAY_LIVE_KEYS_IN_LOWER_ENV',
          `${env} is configured with Razorpay LIVE credentials, which would charge real customers from a non-production environment. ETicketsGo must correct this — contact support.`,
        ),
      );
    } else if (!f.liveEnabled) {
      checks.push(
        block(
          'PAYMENT_LIVE_NOT_ENABLED',
          'Razorpay live credentials are present but live payments are still switched off, so checkout would be refused. ETicketsGo enables this deliberately — contact support.',
        ),
      );
    } else if (checks.length === 0) {
      checks.push(
        ready('RAZORPAY_LIVE_READY', 'Razorpay live payments are configured and enabled.'),
      );
    }
  }

  return checks;
}
