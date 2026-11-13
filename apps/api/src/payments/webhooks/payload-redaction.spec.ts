import {
  REDACTED,
  holdsPersonalData,
  isPersonalKey,
  redactProviderPayload,
} from './payload-redaction';
import { RazorpayWebhookProcessor } from '../razorpay/razorpay-webhook.processor';

/**
 * The payer is removed from stored webhook payloads; everything reconciliation, refunds,
 * disputes and idempotency read must survive untouched. Both directions are pinned here.
 */

// Shaped like a real Razorpay `payment.captured` (UPI) and `payment.failed` (card) delivery.
const razorpayCaptured = {
  account: 'acc_linked_1',
  object: {
    payment: {
      entity: {
        id: 'pay_N1',
        entity: 'payment',
        amount: 103428,
        currency: 'INR',
        status: 'captured',
        order_id: 'order_N1',
        method: 'upi',
        captured: true,
        description: 'ETicketsGo booking',
        card_id: null,
        card: null,
        bank: null,
        wallet: null,
        vpa: 'buyer.name@okhdfc',
        upi: { payer_account_type: 'bank_account', vpa: 'buyer.name@okhdfc' },
        email: 'buyer@example.com',
        contact: '+919800000000',
        notes: { bookingId: 'bk_1', eventId: 'ev_1', organizerId: 'org_1' },
        fee: 2440,
        tax: 372,
        error_code: null,
        error_description: null,
        error_source: null,
        error_step: null,
        error_reason: null,
        acquirer_data: { rrn: '400011112222', upi_transaction_id: 'UPI123' },
        created_at: 1_760_000_000,
      },
    },
    order: {
      entity: {
        id: 'order_N1',
        amount: 103428,
        currency: 'INR',
        receipt: 'bk_1',
        notes: { bookingId: 'bk_1' },
      },
    },
  },
};

const razorpayFailedCard = {
  account: null,
  object: {
    payment: {
      entity: {
        id: 'pay_F1',
        amount: 50000,
        currency: 'INR',
        status: 'failed',
        order_id: 'order_F1',
        method: 'card',
        card_id: 'card_ABC',
        card: { id: 'card_ABC', name: 'Asha K', last4: '4242', network: 'Visa', issuer: 'HDFC' },
        email: 'buyer@example.com',
        contact: '+919800000000',
        notes: { bookingId: 'bk_2' },
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Payment was declined by the bank',
        error_source: 'bank',
        error_step: 'payment_authorization',
        error_reason: 'payment_declined',
        acquirer_data: { auth_code: null },
      },
    },
  },
};

// Shaped like Stripe `checkout.session.completed` and `account.updated`.
const stripeSession = {
  account: 'acct_1',
  object: {
    id: 'cs_1',
    object: 'checkout.session',
    mode: 'payment',
    amount_total: 4999,
    currency: 'usd',
    client_reference_id: 'bk_9',
    payment_intent: 'pi_9',
    payment_status: 'paid',
    metadata: { bookingId: 'bk_9' },
    customer_email: 'buyer@example.com',
    customer_details: {
      email: 'buyer@example.com',
      name: 'Sam Buyer',
      phone: '+15550000000',
      address: { line1: '1 Main St', postal_code: '94105', country: 'US' },
    },
    custom_fields: [{ key: 'company', text: { value: 'Acme' } }],
  },
};

const stripeAccountUpdated = {
  account: 'acct_1',
  object: {
    id: 'acct_1',
    country: 'US',
    default_currency: 'usd',
    charges_enabled: true,
    payouts_enabled: false,
    details_submitted: true,
    requirements: { currently_due: ['individual.ssn_last_4'], disabled_reason: null },
    email: 'organizer@example.com',
    business_profile: { name: 'Org LLC', support_phone: '+15551112222' },
    individual: { first_name: 'Pat', ssn_last_4_provided: true },
    external_accounts: { data: [{ last4: '6789', routing_number: '110000000' }] },
  },
};

const at = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o);

describe('what is removed', () => {
  it.each([
    ['razorpay UPI capture', razorpayCaptured],
    ['razorpay card failure', razorpayFailedCard],
    ['stripe checkout session', stripeSession],
    ['stripe connected account', stripeAccountUpdated],
  ])('%s: no personal field survives', (_label, payload) => {
    expect(holdsPersonalData(payload)).toBe(true);
    const redacted = redactProviderPayload(payload);
    expect(holdsPersonalData(redacted)).toBe(false);
    const text = JSON.stringify(redacted);
    for (const pii of [
      'buyer@example.com',
      'organizer@example.com',
      '+919800000000',
      '+15550000000',
      'buyer.name@okhdfc',
      '4242',
      'Asha K',
      'Sam Buyer',
      '1 Main St',
      '6789',
      '110000000',
      'Org LLC',
    ]) {
      expect(text).not.toContain(pii);
    }
  });

  it('marks what it removed, and leaves an absent value absent', () => {
    const r = redactProviderPayload(razorpayCaptured);
    expect(at(r, 'object.payment.entity.email')).toBe(REDACTED);
    expect(at(r, 'object.payment.entity.upi')).toBe(REDACTED);
    // `card: null` means the provider sent no card; it must not be turned into "[redacted]".
    expect(at(r, 'object.payment.entity.card')).toBeNull();
  });

  it('matches keys case-insensitively, at any depth, inside arrays', () => {
    expect(isPersonalKey('Email')).toBe(true);
    const r = redactProviderPayload({ a: [{ b: { CONTACT: '+1' } }] });
    expect(r).toEqual({ a: [{ b: { CONTACT: REDACTED } }] });
  });

  it('is idempotent and does not mutate its input', () => {
    const before = JSON.stringify(stripeSession);
    const once = redactProviderPayload(stripeSession);
    expect(redactProviderPayload(once)).toEqual(once);
    expect(JSON.stringify(stripeSession)).toBe(before);
  });
});

describe('what reconciliation, refunds, disputes and idempotency read is kept', () => {
  it.each([
    [
      razorpayCaptured,
      [
        'account',
        'object.payment.entity.id',
        'object.payment.entity.order_id',
        'object.payment.entity.amount',
        'object.payment.entity.currency',
        'object.payment.entity.status',
        'object.payment.entity.method',
        'object.payment.entity.notes.bookingId',
        'object.payment.entity.notes.organizerId',
        'object.payment.entity.fee',
        'object.payment.entity.tax',
        'object.payment.entity.acquirer_data.rrn',
        'object.payment.entity.acquirer_data.upi_transaction_id',
        'object.order.entity.receipt',
      ],
    ],
    [
      razorpayFailedCard,
      [
        'object.payment.entity.card_id',
        'object.payment.entity.error_code',
        'object.payment.entity.error_description',
        'object.payment.entity.error_source',
        'object.payment.entity.error_step',
        'object.payment.entity.error_reason',
      ],
    ],
    [
      stripeSession,
      [
        'object.id',
        'object.mode',
        'object.amount_total',
        'object.currency',
        'object.client_reference_id',
        'object.payment_intent',
        'object.payment_status',
        'object.metadata.bookingId',
      ],
    ],
    [
      stripeAccountUpdated,
      [
        'object.id',
        'object.country',
        'object.default_currency',
        'object.charges_enabled',
        'object.payouts_enabled',
        'object.details_submitted',
        'object.requirements.currently_due',
      ],
    ],
  ])('keeps every field the processors read', (payload, paths) => {
    const r = redactProviderPayload(payload);
    for (const p of paths) expect([p, at(r, p)]).toEqual([p, at(payload, p)]);
  });
});

describe('the Razorpay processor acts identically on the redacted copy', () => {
  function run(payload: unknown, eventType: string) {
    const payments = { processVerifiedEvent: jest.fn().mockResolvedValue({ status: 'confirmed' }) };
    const prisma = {
      webhookEvent: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'we_1',
          provider: 'razorpay',
          providerEventId: 'evt_1',
          eventType,
          payload,
          attempts: 1,
        }),
        update: jest.fn(),
      },
      payment: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    };
    const processor = new RazorpayWebhookProcessor(
      prisma as never,
      payments as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
    );
    return { processor, payments };
  }

  it.each([
    ['payment.captured', razorpayCaptured],
    ['payment.failed', razorpayFailedCard],
  ])('%s', async (eventType, payload) => {
    const full = run(payload, eventType);
    const redacted = run(redactProviderPayload(payload), eventType);
    await full.processor.process('we_1');
    await redacted.processor.process('we_1');
    expect(full.payments.processVerifiedEvent).toHaveBeenCalledTimes(1);
    expect(redacted.payments.processVerifiedEvent.mock.calls).toEqual(
      full.payments.processVerifiedEvent.mock.calls,
    );
  });
});
