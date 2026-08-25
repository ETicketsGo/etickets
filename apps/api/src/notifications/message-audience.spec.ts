import { NotificationType } from '@eticketsgo/shared-types';
import { MESSAGE_AUDIENCE, audienceOf, typesForAudience } from './message-class';

/**
 * Which inbox a message belongs in.
 *
 * Reported from QA: the organizer console listed the operator's own ticket purchases. One
 * person, one account, two roles — and the inbox was keyed on user id alone, so both streams
 * arrived in both places.
 */
describe('message audience', () => {
  it('classifies every notification type', () => {
    // `Record<NotificationType, MessageAudience>` makes this a compile error too; this
    // asserts the exhaustiveness has not been loosened to a partial record.
    const unclassified = Object.values(NotificationType).filter((t) => !MESSAGE_AUDIENCE[t]);
    expect(unclassified).toEqual([]);
  });

  it.each([
    NotificationType.BOOKING_CONFIRMED,
    NotificationType.REFUND_COMPLETED,
    NotificationType.EVENT_REMINDER,
    NotificationType.TICKET_TRANSFERRED,
  ])('%s belongs to the buyer', (type) => {
    expect(audienceOf(type)).toBe('CUSTOMER');
  });

  it.each([
    NotificationType.SETTLEMENT_RELEASED,
    NotificationType.PAYOUT_ACCOUNT_UPDATED,
    NotificationType.TRANSFER_FAILED,
    NotificationType.EVENT_APPROVED,
  ])('%s belongs to the organizer', (type) => {
    expect(audienceOf(type)).toBe('ORGANIZER');
  });

  it('keeps the platform moderation queue out of the organizer console', () => {
    // A new organizer registering is the platform's business, not an organizer's, even when
    // the same person happens to hold both roles.
    expect(audienceOf(NotificationType.ORGANIZATION_REGISTERED)).toBe('ADMIN');
    expect(audienceOf(NotificationType.EVENT_SUBMITTED)).toBe('ADMIN');
  });

  it('the three audiences partition the types with no overlap and no gaps', () => {
    const all = Object.values(NotificationType);
    const buckets = (['CUSTOMER', 'ORGANIZER', 'ADMIN'] as const).flatMap(typesForAudience);
    expect(buckets.sort()).toEqual([...all].sort());
    expect(new Set(buckets).size).toBe(buckets.length);
  });

  it('defaults an unknown type to the CUSTOMER inbox', () => {
    /*
      The opposite of the MessageClass default, deliberately.

      There the risk is over-sending, so an unknown type is treated as commercial and
      suppressed. Here the risk is HIDING a message from the person it concerns — and a
      message in the wrong inbox gets reported, as this one was, while a message in no inbox
      does not.
    */
    expect(audienceOf('SOMETHING_ADDED_LATER' as NotificationType)).toBe('CUSTOMER');
  });
});
