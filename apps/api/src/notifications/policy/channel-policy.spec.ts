import { NotificationType } from '@eticketsgo/shared-types';
import { CHANNEL_POLICY, channelsFor, permittedChannels } from './channel-policy';
import { isDedupable } from './dedupe-key';

/**
 * Which channels a kind of message is allowed to use.
 *
 * ── WHY THIS TABLE HAD TO EXIST BEFORE THE RECIPIENT FIX ───────────────────────────
 * Every notification type used to share one default channel list. Fixing the SMS recipient
 * bug in isolation would therefore have been the most expensive one-line change in the
 * platform's history: the moment SMS could reach a phone, every type on the platform would
 * have started sending one — every share-viewed notice, every admin approval — at per-message
 * cost, to real numbers, with no product decision behind any of it.
 *
 * These assert the containment, not just the happy paths.
 */

/** Every type that is not explicitly allowed SMS or WhatsApp. */
const NOT_LISTED = Object.values(NotificationType).filter((t) => !CHANNEL_POLICY[t]);

describe('the paid channels are an allowlist, not a default', () => {
  it('no unlisted type can use SMS or WhatsApp, whatever it asks for', () => {
    const leaked = NOT_LISTED.filter((t) =>
      permittedChannels(t, ['sms', 'whatsapp', 'email']).some((c) =>
        ['sms', 'whatsapp'].includes(c),
      ),
    );
    expect(leaked).toEqual([]);
  });

  it('and there really are unlisted types, so the test above is not vacuous', () => {
    // If a future change listed every type, the assertion above would pass while proving
    // nothing. Most types are, and should stay, email + inbox + push only.
    expect(NOT_LISTED.length).toBeGreaterThan(10);
  });

  it('SMS is allowed for exactly one thing today', () => {
    const withSms = Object.values(NotificationType).filter((t) => channelsFor(t).includes('sms'));
    /*
      A cancelled booking, and nothing else. It is time-critical, it may be the difference
      between somebody travelling to a closed venue or not, and SMS is the only channel that
      reaches a phone with no app, no data and no email set up. Everything else has three
      free channels carrying the same information.
    */
    expect(withSms).toEqual([NotificationType.BOOKING_CANCELLED]);
  });
});

describe('the launch policy', () => {
  it.each([
    [NotificationType.BOOKING_CONFIRMED, ['email', 'in_app', 'push', 'whatsapp']],
    [NotificationType.BOOKING_CANCELLED, ['email', 'in_app', 'push', 'whatsapp', 'sms']],
    [NotificationType.REFUND_COMPLETED, ['email', 'in_app', 'push', 'whatsapp']],
    [NotificationType.PAYMENT_FAILED, ['email', 'in_app', 'push']],
    [NotificationType.EVENT_REMINDER, ['in_app', 'push', 'whatsapp']],
    [NotificationType.SETTLEMENT_RELEASED, ['email', 'in_app']],
  ])('%s → %s', (type, expected) => {
    expect(channelsFor(type).sort()).toEqual([...expected].sort());
  });

  it('a reminder does not go to email', () => {
    // A reminder is a courtesy, not a record. An inbox full of "your show is tomorrow" is
    // how people learn to ignore the sender, and the ticket email already exists.
    expect(channelsFor(NotificationType.EVENT_REMINDER)).not.toContain('email');
  });

  it('an organizer payout does not go to a customer channel', () => {
    const payout = channelsFor(NotificationType.SETTLEMENT_RELEASED);
    expect(payout).not.toContain('whatsapp');
    expect(payout).not.toContain('sms');
    expect(payout).not.toContain('push');
  });
});

describe('the inbox is never lost', () => {
  it('every type keeps its in-app row', () => {
    const missing = Object.values(NotificationType).filter(
      (t) => !channelsFor(t).includes('in_app'),
    );
    // The persisted in-app row IS the notification centre. Dropping it from a type would be
    // a visible product regression dressed up as a policy edit.
    expect(missing).toEqual([]);
  });
});

describe('a caller may narrow, never widen', () => {
  it('honours a narrower request', () => {
    expect(permittedChannels(NotificationType.BOOKING_CONFIRMED, ['email'])).toEqual(['email']);
  });

  it('drops a channel policy does not allow for that type', () => {
    expect(permittedChannels(NotificationType.BOOKING_CONFIRMED, ['email', 'sms'])).toEqual([
      'email',
    ]);
  });

  it('an unknown type falls back to email + inbox + push, which is what it did before', () => {
    expect(channelsFor('SOMETHING_ADDED_LATER' as NotificationType).sort()).toEqual([
      'email',
      'in_app',
      'push',
    ]);
  });
});

describe('duplicate suppression is opt-in for the same reason', () => {
  it('applies to messages that describe a one-time fact', () => {
    for (const t of [
      NotificationType.BOOKING_CONFIRMED,
      NotificationType.BOOKING_CANCELLED,
      NotificationType.REFUND_COMPLETED,
      NotificationType.SETTLEMENT_RELEASED,
    ]) {
      expect(isDedupable(t)).toBe(true);
    }
  });

  it('does NOT apply to messages that may legitimately repeat', () => {
    // A show may be reminded about more than once by design; a second password-reset
    // request is a second request, and suppressing it locks somebody out of their account.
    expect(isDedupable(NotificationType.EVENT_REMINDER)).toBe(false);
    expect(isDedupable(NotificationType.PASSWORD_RESET_REQUESTED)).toBe(false);
    expect(isDedupable(NotificationType.SHARE_VIEWED)).toBe(false);
  });
});
