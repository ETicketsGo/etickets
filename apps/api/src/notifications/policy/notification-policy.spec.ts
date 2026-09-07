import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import {
  EVENT_POLICY,
  channelsFor,
  immediateChannels,
  permittedChannels,
  policyFor,
} from './notification-policy';
import {
  NotificationPolicyResolver,
  WHATSAPP_TRANSACTIONAL_SCOPE,
} from './notification-policy.resolver';

/**
 * Who gets told, on what, and what a customer can and cannot switch off.
 *
 * ── WHAT THIS LAYER IS FOR ─────────────────────────────────────────────────────────
 * The domain says "this booking was cancelled". It does not say "send an SMS", and nothing
 * in this file knows that an Indian SMS goes through MSG91 — that decision is made per
 * message, later, from the destination. Keeping the two apart is why adding a provider took
 * no product decision and why changing a channel takes no vendor knowledge.
 */

const KNOWN = new Set(['email', 'sms', 'whatsapp', 'push', 'in_app']);
const known = (c: string) => KNOWN.has(c);

function resolver(
  opts: { disabled?: string[]; consent?: Record<string, boolean>; optIn?: boolean } = {},
) {
  const preferences = {
    resolveChannels: jest.fn(async (_u: string | null, _t: unknown, requested: string[]) =>
      requested.filter((c) => !(opts.disabled ?? []).includes(c)),
    ),
  };
  const consent = {
    mayReceiveMarketing: jest.fn(async (_s: unknown, channel: string) =>
      Boolean(opts.consent?.[channel]),
    ),
  };
  const config = new ConfigService(
    opts.optIn ? { WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED: 'true' } : {},
  );
  return {
    resolver: new NotificationPolicyResolver(preferences as never, consent as never, config),
    preferences,
    consent,
  };
}

const RECIPIENT = { userId: 'u-1', email: 'buyer@example.test' };

describe('the declared channel matrix', () => {
  it.each([
    [NotificationType.BOOKING_CONFIRMED, ['email', 'in_app', 'push', 'whatsapp']],
    [NotificationType.SHOW_CHANGED, ['email', 'in_app', 'push', 'whatsapp']],
    [NotificationType.REFUND_COMPLETED, ['email', 'in_app', 'push', 'whatsapp']],
    [NotificationType.PAYMENT_FAILED, ['email', 'in_app', 'push']],
    [NotificationType.EVENT_REMINDER, ['in_app', 'push', 'whatsapp']],
    [NotificationType.SETTLEMENT_RELEASED, ['email', 'in_app']],
  ])('%s sends immediately on %s', (type, expected) => {
    expect(immediateChannels(type).sort()).toEqual([...expected].sort());
  });

  it('a cancelled booking may use SMS, but not straight away', () => {
    /*
      Both halves matter. Policy has to PERMIT SMS before anything may use it — that is the
      Phase 1 rule that stops a paid channel being reached by accident. But sending it
      alongside the other three means everybody with a phone gets four messages about one
      cancellation, and we pay for the one they were least likely to need.
    */
    expect(channelsFor(NotificationType.BOOKING_CANCELLED)).toContain('sms');
    expect(immediateChannels(NotificationType.BOOKING_CANCELLED)).not.toContain('sms');
    expect(policyFor(NotificationType.BOOKING_CANCELLED).fallback).toMatchObject({ to: 'sms' });
  });

  it('a booking confirmation can never reach SMS at all', () => {
    // Not immediately, not as a fallback, not by asking for it.
    expect(channelsFor(NotificationType.BOOKING_CONFIRMED)).not.toContain('sms');
    expect(policyFor(NotificationType.BOOKING_CONFIRMED).fallback).toBeUndefined();
    expect(permittedChannels(NotificationType.BOOKING_CONFIRMED, ['sms'])).toEqual([]);
  });

  it('no refund event can reach SMS', () => {
    expect(channelsFor(NotificationType.REFUND_COMPLETED)).not.toContain('sms');
    expect(policyFor(NotificationType.REFUND_COMPLETED).fallback).toBeUndefined();
  });

  it('a cancellation is the ONLY type that may reach SMS', () => {
    const withSms = Object.values(NotificationType).filter((t) => channelsFor(t).includes('sms'));
    expect(withSms).toEqual([NotificationType.BOOKING_CANCELLED]);
  });

  it('an organizer payout stays on email and the console', () => {
    const payout = channelsFor(NotificationType.SETTLEMENT_RELEASED);
    expect(payout).toEqual(expect.arrayContaining(['email', 'in_app']));
    expect(payout).not.toContain('whatsapp');
    expect(payout).not.toContain('sms');
    expect(payout).not.toContain('push');
  });

  it('an unlisted type is deterministic, and never a paid channel', () => {
    const unknown = channelsFor('SOMETHING_ADDED_LATER' as NotificationType);
    expect(unknown.sort()).toEqual(['email', 'in_app', 'push']);
    expect(unknown).not.toContain('sms');
    expect(unknown).not.toContain('whatsapp');
  });

  it('every declared policy keeps the inbox', () => {
    for (const type of Object.keys(EVENT_POLICY) as NotificationType[]) {
      expect(channelsFor(type)).toContain('in_app');
    }
  });
});

describe('what a customer can turn off', () => {
  it('honours an ordinary opt-out', async () => {
    const { resolver } = resolver_({ disabled: ['whatsapp'] });
    const out = await resolver.resolve({
      type: NotificationType.BOOKING_CONFIRMED,
      recipient: RECIPIENT,
      known,
    });
    expect(out.channels).not.toContain('whatsapp');
    // The alternatives are untouched — that is the whole point of a per-channel preference.
    expect(out.channels).toEqual(expect.arrayContaining(['email', 'push', 'in_app']));
    expect(out.removed).toEqual([{ channel: 'whatsapp', reason: 'preference' }]);
  });

  it('will not let somebody switch off every channel a cancellation could reach them on', async () => {
    /*
      Usually done one unchecked box at a time, months apart, with no moment where the
      consequence is visible. They then travel to a venue with nothing on, and every single
      opt-out was honoured exactly as asked.
    */
    const { resolver } = resolver_({ disabled: ['email', 'in_app', 'push', 'whatsapp'] });
    const out = await resolver.resolve({
      type: NotificationType.BOOKING_CANCELLED,
      recipient: RECIPIENT,
      known,
    });
    expect(out.channels).toEqual(expect.arrayContaining(['email', 'in_app']));
  });

  it('but a reminder can be switched off completely except for the inbox', async () => {
    // The floor is not a licence to ignore preferences. A reminder is a courtesy, and the
    // only thing that survives is the row in the notification centre.
    const { resolver } = resolver_({ disabled: ['push', 'whatsapp', 'in_app'] });
    const out = await resolver.resolve({
      type: NotificationType.EVENT_REMINDER,
      recipient: RECIPIENT,
      known,
    });
    expect(out.channels).toEqual(['in_app']);
  });

  it('does not consult preferences for somebody with no account', async () => {
    const { resolver, preferences } = resolver_();
    await resolver.resolve({
      type: NotificationType.BOOKING_CONFIRMED,
      recipient: { email: 'guest@example.test' },
      known,
    });
    expect(preferences.resolveChannels).not.toHaveBeenCalled();
  });
});

describe('marketing consent does not govern tickets', () => {
  it('a booking confirmation goes out with no consent on file at all', async () => {
    /*
      Withholding a ticket because somebody declined a newsletter would be a product failure
      dressed up as a legal precaution.
    */
    const { resolver, consent } = resolver_({ consent: {} });
    const out = await resolver.resolve({
      type: NotificationType.BOOKING_CONFIRMED,
      recipient: RECIPIENT,
      known,
    });
    expect(out.transactional).toBe(true);
    expect(out.channels.length).toBeGreaterThan(0);
    // Not merely allowed — the consent store was never asked, so a transactional message
    // cannot become dependent on a lookup that could fail or be misconfigured.
    expect(consent.mayReceiveMarketing).not.toHaveBeenCalled();
  });

  it('a commercial message needs an affirmative record per channel', async () => {
    const { resolver } = resolver_({ consent: { email: true } });
    const out = await resolver.resolve({
      type: 'PROMOTIONAL_BLAST' as NotificationType,
      recipient: RECIPIENT,
      known,
    });
    expect(out.transactional).toBe(false);
    expect(out.channels).toEqual(['email']);
    expect(out.removed.map((r) => r.reason)).toContain('no marketing consent');
  });
});

describe('WhatsApp opt-in is a different question from marketing', () => {
  it('is not enforced by default, so nobody who was never asked loses WhatsApp', async () => {
    // Turning it on before the opt-in has been COLLECTED would stop every existing
    // customer's WhatsApp overnight — absence of a consent record correctly means no.
    const { resolver } = resolver_({ consent: {} });
    const out = await resolver.resolve({
      type: NotificationType.BOOKING_CONFIRMED,
      recipient: RECIPIENT,
      known,
    });
    expect(out.channels).toContain('whatsapp');
  });

  it('when enforced, asks the transactional scope and not the marketing one', async () => {
    const { resolver, consent } = resolver_({
      optIn: true,
      // Opted OUT of marketing WhatsApp, opted IN to being reached there about a booking.
      consent: { whatsapp: false, [WHATSAPP_TRANSACTIONAL_SCOPE]: true },
    });
    const out = await resolver.resolve({
      type: NotificationType.BOOKING_CONFIRMED,
      recipient: RECIPIENT,
      known,
    });

    expect(out.channels).toContain('whatsapp');
    expect(consent.mayReceiveMarketing).toHaveBeenCalledWith(
      expect.anything(),
      WHATSAPP_TRANSACTIONAL_SCOPE,
    );
  });

  it('a missing opt-in removes the CHANNEL, never the notification', async () => {
    const { resolver } = resolver_({ optIn: true, consent: {} });
    const out = await resolver.resolve({
      type: NotificationType.BOOKING_CONFIRMED,
      recipient: RECIPIENT,
      known,
    });

    expect(out.channels).not.toContain('whatsapp');
    // The ticket still goes.
    expect(out.channels).toEqual(expect.arrayContaining(['email', 'push', 'in_app']));
    expect(out.removed).toContainEqual({ channel: 'whatsapp', reason: 'no channel opt-in' });
  });
});

describe('the deferred channel', () => {
  it('is unreachable by an ordinary caller, even one that names it', async () => {
    const { resolver } = resolver_();
    const out = await resolver.resolve({
      type: NotificationType.BOOKING_CANCELLED,
      recipient: RECIPIENT,
      requested: ['sms'],
      known,
    });
    expect(out.channels).toEqual([]);
  });

  it('is reachable only by the fallback path', async () => {
    const { resolver } = resolver_();
    const out = await resolver.resolve({
      type: NotificationType.BOOKING_CANCELLED,
      recipient: RECIPIENT,
      requested: ['sms'],
      known,
      allowDeferred: true,
    });
    expect(out.channels).toEqual(['sms']);
  });
});

/* Named apart from the `resolver` variable the tests destructure out of it. */
function resolver_(opts: Parameters<typeof resolver>[0] = {}) {
  return resolver(opts);
}
