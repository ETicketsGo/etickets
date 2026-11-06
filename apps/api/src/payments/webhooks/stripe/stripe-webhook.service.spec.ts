import { WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * The Stripe webhook endpoint must verify with the STRIPE adapter.
 *
 * ── THE BUG THIS PINS DOWN ─────────────────────────────────────────────────────────
 * It used to inject `PAYMENT_PROVIDER` — the single globally configured provider, which
 * is `mock` unless somebody flips a global switch. So with correct Stripe keys and a
 * genuinely Stripe-signed event arriving at the Stripe endpoint, ingestion answered
 * `501 The active provider does not support Stripe webhooks`, and every delivery failed.
 *
 * There is no single "active provider" on this platform: routing is per booking, from the
 * booking's currency — USD to Stripe, INR to Razorpay. An endpoint named for a provider
 * has to resolve THAT provider. The Razorpay endpoint always did; this one did not, and
 * nothing noticed until Stripe keys existed to expose it.
 *
 * These tests are about WHICH adapter is asked, which is the part that was wrong.
 */
const envelope = {
  id: 'evt_1',
  type: 'payment_intent.succeeded',
  createdAt: 1,
  account: null,
  object: { id: 'pi_1' },
};

function setup() {
  const stripeAdapter = {
    name: 'stripe',
    verifySignedEnvelope: jest.fn().mockReturnValue(envelope),
  };
  // A DIFFERENT adapter, standing in for whatever is globally configured. If the service
  // ever reaches for this one again, the assertions below fail.
  const globalAdapter = {
    name: 'mock',
    verifySignedEnvelope: jest.fn(() => {
      throw new Error('the mock provider must never be asked to verify a Stripe event');
    }),
  };
  const resolver = { get: jest.fn().mockReturnValue(stripeAdapter) };

  const prisma = {
    webhookEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'we_1', processingStatus: 'RECEIVED' }),
      update: jest.fn().mockResolvedValue({ id: 'we_1' }),
    },
  };
  const processor = { process: jest.fn().mockResolvedValue('processed') };
  const metrics = { recordPaymentWebhook: jest.fn() };

  const service = new StripeWebhookService(
    prisma as never,
    resolver as never,
    processor as never,
    metrics as never,
  );
  return { service, resolver, stripeAdapter, globalAdapter, prisma, processor };
}

describe('StripeWebhookService.ingest', () => {
  it('resolves the adapter by name rather than using the globally configured provider', async () => {
    const { service, resolver, stripeAdapter } = setup();

    await service.ingest('{}', 'sig');

    expect(resolver.get).toHaveBeenCalledWith('stripe');
    expect(stripeAdapter.verifySignedEnvelope).toHaveBeenCalledWith({
      rawBody: '{}',
      signature: 'sig',
    });
  });

  it('records the event under Stripe’s own event id, so a re-delivery is a no-op', async () => {
    // Two destinations on one URL — which is what the QA dashboard had — deliver every
    // event twice. Dedup on the provider's event id is what makes that harmless.
    const { service, prisma } = setup();
    prisma.webhookEvent.findUnique.mockResolvedValue({
      id: 'we_1',
      processingStatus: WebhookProcessingStatus.PROCESSED,
    });

    const result = await service.ingest('{}', 'sig');

    expect(result).toEqual({ received: true, duplicate: true });
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('answers a copy that lost the insert race as a duplicate, not a 500', async () => {
    // Two replicas, one event delivered twice at once: the second insert hits the unique key.
    const { service, prisma, processor } = setup();
    prisma.webhookEvent.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    const result = await service.ingest('{}', 'sig');
    expect(result).toEqual({ received: true, duplicate: true });
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('rethrows any other database error from the insert', async () => {
    const { service, prisma } = setup();
    prisma.webhookEvent.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.ingest('{}', 'sig')).rejects.toThrow('connection lost');
  });

  it('lets a verification failure through rather than swallowing it', async () => {
    // An unverified body is not evidence of anything. The endpoint must refuse, not record.
    const { service, stripeAdapter, prisma } = setup();
    stripeAdapter.verifySignedEnvelope.mockImplementation(() => {
      throw new Error('Invalid webhook signature.');
    });

    await expect(service.ingest('{}', 'bad')).rejects.toThrow(/signature/i);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });
});
