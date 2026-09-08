import { createHmac } from 'node:crypto';
import { DeliveryState } from '@eticketsgo/shared-types';
import { parseMetaCloud, parseMsg91, parseSesEvent, parseTwilio } from './delivery-webhook.parsers';
import {
  verifyMetaSignature,
  verifySharedSecret,
  verifyTwilioSignature,
} from './delivery-webhook.signatures';

/**
 * Reading what each provider posts, and proving it came from them.
 *
 * ── WHY THE PARSERS ARE TESTED WITHOUT A DATABASE ──────────────────────────────────
 * The interesting cases — a malformed body, an unknown status, a bounce naming three
 * recipients — are decisions about what a provider MEANT, and they are the same decisions
 * whether or not anything is stored. Separating them means these run in milliseconds and
 * cover every shape, rather than a handful of happy paths behind a fixture.
 */

describe('Twilio status callbacks', () => {
  it('reads a delivery', () => {
    const event = parseTwilio({
      MessageSid: 'SM123',
      MessageStatus: 'delivered',
      To: '+14155550123',
    });
    expect(event).toMatchObject({
      providerMessageId: 'SM123',
      state: DeliveryState.DELIVERED,
      providerStatus: 'delivered',
    });
  });

  it('does not read "sent" as delivered', () => {
    // `sent` means the carrier has it. This is the distinction the whole phase is about.
    expect(parseTwilio({ MessageSid: 'SM1', MessageStatus: 'sent' })?.state).toBe(
      DeliveryState.ACCEPTED,
    );
  });

  it('separates a dead number from a switched-off handset', () => {
    const dead = parseTwilio({ MessageSid: 'SM2', MessageStatus: 'failed', ErrorCode: '21211' });
    const off = parseTwilio({
      MessageSid: 'SM3',
      MessageStatus: 'undelivered',
      ErrorCode: '30003',
    });
    expect(dead?.state).toBe(DeliveryState.REJECTED);
    expect(off?.state).toBe(DeliveryState.UNDELIVERED);
  });

  it('carries the destination so a permanent failure can suppress it', () => {
    const event = parseTwilio({
      MessageSid: 'SM4',
      MessageStatus: 'failed',
      ErrorCode: '21610',
      To: '+919876543210',
    });
    expect(event?.destination).toBe('+919876543210');
  });

  it('gives the same status on the same message the same event id, so a replay is caught', () => {
    const a = parseTwilio({ MessageSid: 'SM5', MessageStatus: 'delivered' });
    const b = parseTwilio({ MessageSid: 'SM5', MessageStatus: 'delivered' });
    expect(a?.eventId).toBe(b?.eventId);
    // …and a different status is a different event.
    expect(parseTwilio({ MessageSid: 'SM5', MessageStatus: 'sent' })?.eventId).not.toBe(a?.eventId);
  });

  it('returns nothing for a body with no message or no status', () => {
    expect(parseTwilio({})).toBeNull();
    expect(parseTwilio({ MessageSid: 'SM6' })).toBeNull();
    expect(parseTwilio({ MessageStatus: 'delivered' })).toBeNull();
  });
});

describe('Meta WhatsApp Cloud callbacks', () => {
  const envelope = (statuses: unknown[]) => ({
    entry: [{ changes: [{ value: { statuses } }] }],
  });

  it('reads a delivery', () => {
    const events = parseMetaCloud(
      envelope([
        {
          id: 'wamid.1',
          status: 'delivered',
          timestamp: '1757000000',
          recipient_id: '919876543210',
        },
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerMessageId: 'wamid.1',
      state: DeliveryState.DELIVERED,
      destination: '919876543210',
    });
    expect(events[0].occurredAt?.toISOString()).toBe('2025-09-04T15:33:20.000Z');
  });

  it('reads several statuses from one POST', () => {
    // Meta batches. Handling only the first would silently drop the rest.
    const events = parseMetaCloud(
      envelope([
        { id: 'wamid.a', status: 'sent' },
        { id: 'wamid.b', status: 'delivered' },
        { id: 'wamid.c', status: 'read' },
      ]),
    );
    expect(events.map((e) => e.state)).toEqual([
      DeliveryState.ACCEPTED,
      DeliveryState.DELIVERED,
      DeliveryState.READ,
    ]);
  });

  it('separates "not on WhatsApp" from "did not land"', () => {
    const permanent = parseMetaCloud(
      envelope([
        { id: 'w1', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] },
      ]),
    );
    const transient = parseMetaCloud(
      envelope([{ id: 'w2', status: 'failed', errors: [{ code: 131047 }] }]),
    );
    expect(permanent[0].state).toBe(DeliveryState.REJECTED);
    expect(transient[0].state).toBe(DeliveryState.UNDELIVERED);
  });

  it('returns nothing rather than throwing on a shape it does not recognise', () => {
    // A verification challenge, a message-received event, a truncated body. None of these
    // are errors and none of them may crash a public endpoint.
    expect(parseMetaCloud({})).toEqual([]);
    expect(parseMetaCloud({ entry: 'not-an-array' })).toEqual([]);
    expect(parseMetaCloud({ entry: [{ changes: [{ value: {} }] }] })).toEqual([]);
    expect(parseMetaCloud(null)).toEqual([]);
  });
});

describe('MSG91 delivery reports', () => {
  it('reads a delivery by numeric code and by word', () => {
    expect(parseMsg91({ requestId: 'r1', status: '1' })?.state).toBe(DeliveryState.DELIVERED);
    expect(parseMsg91({ request_id: 'r2', status: 'delivered' })?.state).toBe(
      DeliveryState.DELIVERED,
    );
  });

  it('reads DND and blocked as a rejection', () => {
    // An Indian number on the Do Not Disturb registry will not receive it, ever.
    expect(parseMsg91({ requestId: 'r3', status: '17' })?.state).toBe(DeliveryState.REJECTED);
    expect(parseMsg91({ requestId: 'r4', status: '9' })?.state).toBe(DeliveryState.REJECTED);
  });

  it('returns nothing for a code nobody has mapped, rather than guessing', () => {
    // MSG91 report shapes are account-configurable. An unmapped code is information we do
    // not have; recording it as delivered would be an invention.
    expect(parseMsg91({ requestId: 'r5', status: '9999' })).toBeNull();
    expect(parseMsg91({ status: '1' })).toBeNull();
    expect(parseMsg91({})).toBeNull();
  });
});

describe('SES events over SNS', () => {
  const mail = {
    messageId: 'ses-1',
    timestamp: '2026-09-07T10:00:00.000Z',
    destination: ['a@b.test'],
  };

  it('reads a delivery', () => {
    const events = parseSesEvent({ eventType: 'Delivery', mail });
    expect(events[0]).toMatchObject({ providerMessageId: 'ses-1', state: DeliveryState.DELIVERED });
  });

  it('splits a bounce on permanence, not on the word "Bounce"', () => {
    const permanent = parseSesEvent({
      eventType: 'Bounce',
      mail,
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'dead@b.test', diagnosticCode: '550 no such user' }],
      },
    });
    const transient = parseSesEvent({
      eventType: 'Bounce',
      mail,
      bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'full@b.test' }] },
    });
    expect(permanent[0].state).toBe(DeliveryState.BOUNCED);
    expect(permanent[0].destination).toBe('dead@b.test');
    // A full mailbox is not a dead address. Suppressing on it would stop somebody's tickets.
    expect(transient[0].state).toBe(DeliveryState.UNDELIVERED);
  });

  it('produces one event per bounced recipient', () => {
    // One SES bounce can name several addresses, and each is a separate destination that may
    // or may not need suppressing.
    const events = parseSesEvent({
      eventType: 'Bounce',
      mail,
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'a@b.test' }, { emailAddress: 'c@d.test' }],
      },
    });
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(2);
  });

  it('reads a complaint', () => {
    const events = parseSesEvent({
      notificationType: 'Complaint',
      mail,
      complaint: {
        complainedRecipients: [{ emailAddress: 'angry@b.test' }],
        complaintFeedbackType: 'abuse',
      },
    });
    expect(events[0].state).toBe(DeliveryState.COMPLAINED);
    expect(events[0].failureCode).toBe('abuse');
  });

  it('returns nothing for an event with no message id or an unmapped type', () => {
    expect(parseSesEvent({ eventType: 'Delivery' })).toEqual([]);
    expect(parseSesEvent({ eventType: 'SomethingNew', mail })).toEqual([]);
    expect(parseSesEvent(null)).toEqual([]);
  });
});

describe('proving the caller is who they claim to be', () => {
  it('accepts a correctly signed Twilio callback and rejects a tampered one', () => {
    const token = 'twilio-auth-token';
    const url = 'https://api.eticketsgo.com/api/notifications/webhooks/twilio';
    const params = { MessageSid: 'SM1', MessageStatus: 'delivered', To: '+14155550123' };
    const signature = createHmac('sha1', token)
      .update(
        Object.keys(params)
          .sort()
          .reduce((acc, k) => acc + k + String((params as Record<string, string>)[k]), url),
      )
      .digest('base64');

    expect(verifyTwilioSignature(token, url, params, signature)).toBe(true);
    // Changing one field invalidates it — which is the point, since that field is the status
    // that decides whether a destination gets suppressed.
    expect(
      verifyTwilioSignature(token, url, { ...params, MessageStatus: 'failed' }, signature),
    ).toBe(false);
    // As does calling a different URL, which is why the public base has to be configured.
    expect(verifyTwilioSignature(token, `${url}x`, params, signature)).toBe(false);
    expect(verifyTwilioSignature('', url, params, signature)).toBe(false);
    expect(verifyTwilioSignature(token, url, params, '')).toBe(false);
  });

  it('accepts a correctly signed Meta callback over the RAW body', () => {
    const secret = 'meta-app-secret';
    const raw = '{"entry":[{"changes":[{"value":{"statuses":[]}}]}]}';
    const sig = 'sha256=' + createHmac('sha256', secret).update(raw, 'utf8').digest('hex');

    expect(verifyMetaSignature(secret, raw, sig)).toBe(true);
    // Re-serialising a parsed body is not byte-identical, which is why the raw bytes are
    // what gets verified.
    expect(verifyMetaSignature(secret, JSON.stringify(JSON.parse(raw)) + ' ', sig)).toBe(false);
    expect(verifyMetaSignature(secret, raw, 'sha256=deadbeef')).toBe(false);
    expect(verifyMetaSignature('', raw, sig)).toBe(false);
  });

  it('compares a shared secret without leaking its length', () => {
    expect(verifySharedSecret('s3cret', 's3cret')).toBe(true);
    expect(verifySharedSecret('s3cret', 's3cre')).toBe(false);
    expect(verifySharedSecret('s3cret', 'wrong!')).toBe(false);
    // Unconfigured means nothing is accepted, rather than everything.
    expect(verifySharedSecret(undefined, '')).toBe(false);
    expect(verifySharedSecret(undefined, 'anything')).toBe(false);
  });
});
