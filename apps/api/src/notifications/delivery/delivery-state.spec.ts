import {
  DeliveryState,
  SuppressionReason,
  advancesDelivery,
  isTerminalDelivery,
  isTwilioOptOut,
  providerOptOut,
  mayAutomaticallyRetry,
  metaFailureState,
  normalizeProviderStatus,
  resolveDeliveryState,
  sesBounceState,
  suppressionFor,
  twilioFailureState,
} from '@eticketsgo/shared-types';

/**
 * What a provider said, and what this platform concludes from it.
 *
 * ── THE DEFECT ALL OF THIS EXISTS FOR ──────────────────────────────────────────────
 * `Notification.status` went to SENT the moment SES returned a message id. SES returning a
 * message id means SES has queued something; it does not mean an inbox received it. A hard
 * bounce ten seconds later changed nothing — the row still said SENT, and the customer who
 * never got their ticket had no trace anywhere.
 */

describe('a delivery never goes backwards', () => {
  it('keeps DELIVERED when a late SENT arrives', () => {
    /*
      Not hypothetical. Twilio's `sent` and `delivered` are two HTTP requests racing across
      the internet and they arrive out of order regularly. Applying the late one would tell
      an operator a message that reached somebody is still in flight.
    */
    expect(resolveDeliveryState(DeliveryState.DELIVERED, DeliveryState.ACCEPTED)).toBe(
      DeliveryState.DELIVERED,
    );
    expect(advancesDelivery(DeliveryState.DELIVERED, DeliveryState.ACCEPTED)).toBe(false);
  });

  it('keeps READ when DELIVERED arrives afterwards', () => {
    // WhatsApp routinely reports `read` before `delivered`.
    expect(resolveDeliveryState(DeliveryState.READ, DeliveryState.DELIVERED)).toBe(
      DeliveryState.READ,
    );
  });

  it('lets a bounce overrule a delivery', () => {
    /*
      The one case where a LATER state that looks worse is the truth. "Delivered to the
      receiving server" and "the mailbox rejected it" are different hops, and the bounce is
      the one that must stop future sends. Ranking delivery above it would leave a dead
      address unsuppressed and quietly costing sending reputation on every send.
    */
    expect(resolveDeliveryState(DeliveryState.DELIVERED, DeliveryState.BOUNCED)).toBe(
      DeliveryState.BOUNCED,
    );
    expect(resolveDeliveryState(DeliveryState.READ, DeliveryState.COMPLAINED)).toBe(
      DeliveryState.COMPLAINED,
    );
  });

  it('ignores the same event twice', () => {
    for (const state of Object.values(DeliveryState)) {
      expect(advancesDelivery(state, state)).toBe(false);
    }
  });

  it('moves forward through the ordinary path', () => {
    const path = [
      DeliveryState.PENDING,
      DeliveryState.ATTEMPTING,
      DeliveryState.ACCEPTED,
      DeliveryState.DELIVERED,
      DeliveryState.READ,
    ];
    for (let i = 1; i < path.length; i++) {
      expect(advancesDelivery(path[i - 1], path[i])).toBe(true);
    }
  });

  it('treats terminal outcomes as terminal', () => {
    expect(isTerminalDelivery(DeliveryState.BOUNCED)).toBe(true);
    expect(isTerminalDelivery(DeliveryState.UNDELIVERED)).toBe(true);
    expect(isTerminalDelivery(DeliveryState.ACCEPTED)).toBe(false);
  });
});

describe('what stops a destination being used again', () => {
  it('suppresses a bounce, a complaint and a rejection', () => {
    expect(suppressionFor(DeliveryState.BOUNCED)).toBe(SuppressionReason.HARD_BOUNCE);
    expect(suppressionFor(DeliveryState.COMPLAINED)).toBe(SuppressionReason.COMPLAINT);
    expect(suppressionFor(DeliveryState.REJECTED)).toBe(SuppressionReason.BLOCKED_BY_PROVIDER);
  });

  it('does NOT suppress on a transient failure', () => {
    /*
      The expensive mistake. A handset that was switched off, a mailbox that was full, a
      request that timed out — none say anything about the destination, and suppressing on
      them would silently stop somebody's tickets because their phone was in a tunnel.
    */
    expect(suppressionFor(DeliveryState.UNDELIVERED)).toBeNull();
    expect(suppressionFor(DeliveryState.FAILED)).toBeNull();
    expect(suppressionFor(DeliveryState.ACCEPTED)).toBeNull();
  });
});

describe('retrying a send is not resending a message', () => {
  it('retries a send that never reached the provider', () => {
    // Nobody received anything and nobody was charged, so another attempt is free.
    expect(mayAutomaticallyRetry(DeliveryState.FAILED)).toBe(true);
    expect(mayAutomaticallyRetry(DeliveryState.PENDING)).toBe(true);
  });

  it('never automatically resends something the provider ACCEPTED', () => {
    /*
      Twilio accepting an SMS and the carrier later reporting UNDELIVERED is not an HTTP
      failure. The provider took it and charged for it. Sending again is a second message and
      a second charge on a guess — and for a switched-off phone the carrier may yet deliver
      the first, so the customer gets their ticket twice at our expense.
    */
    expect(mayAutomaticallyRetry(DeliveryState.UNDELIVERED)).toBe(false);
    expect(mayAutomaticallyRetry(DeliveryState.ACCEPTED)).toBe(false);
    expect(mayAutomaticallyRetry(DeliveryState.DELIVERED)).toBe(false);
    expect(mayAutomaticallyRetry(DeliveryState.BOUNCED)).toBe(false);
  });
});

describe('each provider says it differently', () => {
  it('does not read Twilio "sent" as delivered', () => {
    // `sent` means the CARRIER has it. Treating it as delivery is the same class of error
    // as treating an SES message id as an inbox.
    expect(normalizeProviderStatus('twilio', 'sent')).toBe(DeliveryState.ACCEPTED);
    expect(normalizeProviderStatus('twilio', 'delivered')).toBe(DeliveryState.DELIVERED);
  });

  it('does not read Twilio "undelivered" as anything like success', () => {
    expect(normalizeProviderStatus('twilio', 'undelivered')).toBe(DeliveryState.UNDELIVERED);
  });

  it('does not read Meta "sent" as delivered either', () => {
    expect(normalizeProviderStatus('cloud', 'sent')).toBe(DeliveryState.ACCEPTED);
    expect(normalizeProviderStatus('cloud', 'delivered')).toBe(DeliveryState.DELIVERED);
    expect(normalizeProviderStatus('cloud', 'read')).toBe(DeliveryState.READ);
  });

  it('reads SES Delivery as the furthest email can prove', () => {
    expect(normalizeProviderStatus('ses', 'Delivery')).toBe(DeliveryState.DELIVERED);
    expect(normalizeProviderStatus('ses', 'Complaint')).toBe(DeliveryState.COMPLAINED);
  });

  it('returns null for a status nobody has mapped', () => {
    // Information we do not have. Recording the provider's own word and leaving the state
    // alone is the honest answer; inventing a state and acting on it is not.
    expect(normalizeProviderStatus('twilio', 'teleported')).toBeNull();
    expect(normalizeProviderStatus('unknown-provider', 'delivered')).toBeNull();
    expect(normalizeProviderStatus('twilio', null)).toBeNull();
  });
});

describe('the failure codes that decide permanence', () => {
  it('splits an SES bounce on its type, not its name', () => {
    /*
      `Bounce` is two different facts. Permanent means the mailbox does not exist and every
      further send is charged against sending reputation — which is what gets an account
      throttled. Transient is a full inbox, and suppressing on it would stop somebody's
      tickets because their mailbox was full on a Tuesday.
    */
    expect(sesBounceState('Permanent')).toBe(DeliveryState.BOUNCED);
    expect(sesBounceState('Transient')).toBe(DeliveryState.UNDELIVERED);
    expect(sesBounceState(undefined)).toBe(DeliveryState.UNDELIVERED);
  });

  it('splits a Twilio failure on its error code', () => {
    // 21211 is a number that does not exist; 30003 is a handset that is switched off. Only
    // the first says anything about the destination.
    expect(twilioFailureState('failed', '21211')).toBe(DeliveryState.REJECTED);
    expect(twilioFailureState('undelivered', '30003')).toBe(DeliveryState.UNDELIVERED);
    expect(twilioFailureState('undelivered', null)).toBe(DeliveryState.UNDELIVERED);
  });

  it('recognises a STOP reply as an opt-out, and records it as one', () => {
    // A legal instruction, not a delivery outcome.
    expect(isTwilioOptOut('21610')).toBe(true);
    expect(isTwilioOptOut('30003')).toBe(false);
    // The state alone still reads as a provider block...
    expect(suppressionFor(twilioFailureState('failed', '21610'))).toBe(
      SuppressionReason.BLOCKED_BY_PROVIDER,
    );
    // ...which is why the opt-out is recorded explicitly. Filed as a block, an operator lifting
    // carrier blocks after an incident would resume texting somebody who asked us to stop.
    expect(providerOptOut('twilio', '21610')).toBe(SuppressionReason.UNSUBSCRIBED);
    expect(providerOptOut('twilio', 21610)).toBe(SuppressionReason.UNSUBSCRIBED);
    expect(providerOptOut('msg91', 'unsubscribed')).toBe(SuppressionReason.UNSUBSCRIBED);
    expect(providerOptOut('twilio', '21211')).toBeNull();
    expect(providerOptOut('twilio', null)).toBeNull();
    expect(providerOptOut('ses', '21610')).toBeNull();
  });

  it('splits a Meta failure on its error code', () => {
    // 131026 is "not on WhatsApp", which is permanent for this channel. 131047 is a
    // re-engagement window error, which is about timing.
    expect(metaFailureState('131026')).toBe(DeliveryState.REJECTED);
    expect(metaFailureState('131047')).toBe(DeliveryState.UNDELIVERED);
    expect(metaFailureState(null)).toBe(DeliveryState.UNDELIVERED);
  });
});
