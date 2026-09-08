import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import { resolvePhoneDestination } from './phone-destination';
import { maskPhone } from './transports/recipient.util';
import { SmsChannel } from './sms.channel';
import { WhatsAppChannel } from './whatsapp.channel';
import { NotificationProviderResolver } from './notification-provider.resolver';
import type { RenderedNotification } from './notification-channel.interface';

/**
 * Who an SMS or WhatsApp message actually goes to.
 *
 * ── THE BUG THESE EXIST FOR ────────────────────────────────────────────────────────
 * The transports read the recipient from `payload.phone`, and no caller has ever put one
 * there. `User.phone` has been a unique column since phone sign-in shipped — it is the
 * identity most Indian buyers use — and nothing connected the two. So every SMS and every
 * WhatsApp message the platform believed it had sent was skipped with a warning, and the
 * `Notification` row said SENT.
 *
 * That exact bug was already found once, for push: devices registered, tokens accumulated in
 * `UserDevice`, and nothing sent to them. This is the same fix applied to the other two
 * channels, and the security half of it — that a payload cannot redirect a message — is why
 * the payload is not simply used as a fallback everywhere.
 */

function msg(over: Partial<RenderedNotification> = {}): RenderedNotification {
  return {
    type: NotificationType.BOOKING_CANCELLED,
    channel: 'sms',
    locale: 'en',
    subject: 'S',
    body: 'Your show is cancelled',
    // BOOKING_CANCELLED's contract requires a reference. This suite is about which NUMBER a
    // message goes to, but the channel now refuses an incomplete message before it routes
    // one -- so the fixture has to be a message the platform would actually send.
    payload: { reference: 'ETG-IND-2026-000123' },
    userId: 'u1',
    ...over,
  };
}

const prismaWith = (phone: string | null) =>
  ({
    user: { findUnique: jest.fn().mockResolvedValue(phone ? { phone } : { phone: null }) },
  }) as never;

const noUser = { user: { findUnique: jest.fn().mockResolvedValue(null) } } as never;

describe('resolving the destination from authoritative data', () => {
  it('uses the number on the recipient account', async () => {
    const out = await resolvePhoneDestination(msg(), prismaWith('+919876543210'));
    expect(out.destination).toBe('+919876543210');
  });

  it('resolves nothing for an account with no number, and does not fail', async () => {
    const out = await resolvePhoneDestination(msg(), prismaWith(null));
    expect(out.destination).toBeUndefined();
  });

  it('works for an account created by phone sign-in and for one created by email', async () => {
    // Both are the same lookup — the column does not record how the account was made — but
    // the two cases are what "SMS reaches our users" actually means in each market.
    for (const phone of ['+919876543210', '+14155550123']) {
      expect((await resolvePhoneDestination(msg(), prismaWith(phone))).destination).toBe(phone);
    }
  });

  it('accepts a payload number when there is no account to look up', async () => {
    /*
      The sign-in code path. A code goes to a number that may belong to nobody yet, which is
      the entire point of it, so there is nothing to be authoritative about.
    */
    const out = await resolvePhoneDestination(
      msg({ userId: null, payload: { phone: '+919999999999' } }),
      prismaWith(null),
    );
    expect(out.destination).toBe('+919999999999');
  });

  it('a payload CANNOT redirect a message away from the account it belongs to', async () => {
    /*
      The security property. Sixteen services build payloads, some from request bodies. If a
      payload could name the destination, anything able to influence one could have somebody
      else's ticket, refund notice or QR sent to a number of its choosing — and the resulting
      row would look entirely ordinary.
    */
    const out = await resolvePhoneDestination(
      msg({ payload: { phone: '+15550001111' } }),
      prismaWith('+919876543210'),
    );
    expect(out.destination).toBe('+919876543210');
  });

  it('does not fall back to a payload number when the account has none', async () => {
    // An account whose owner never gave us a number is precisely the case where a
    // payload-supplied one would be somebody else's.
    const out = await resolvePhoneDestination(
      msg({ payload: { phone: '+15550001111' } }),
      prismaWith(null),
    );
    expect(out.destination).toBeUndefined();
  });

  it('survives a recipient that no longer exists', async () => {
    expect((await resolvePhoneDestination(msg(), noUser)).destination).toBeUndefined();
  });
});

describe('what reaches the logs', () => {
  it('masks a number down to its country code and last two digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91***10');
    expect(maskPhone('+14155550123')).toBe('+1***23');
  });

  it('says nothing at all about an absent or too-short number', () => {
    expect(maskPhone(null)).toBe('n/a');
    expect(maskPhone('12')).toBe('***');
  });

  it('never contains the full number', () => {
    const full = '+919876543210';
    expect(maskPhone(full)).not.toContain('9876543');
  });
});

describe('the channels use it', () => {
  const providers = () => new NotificationProviderResolver(new ConfigService({}));

  it('SMS reports a clean skip rather than failing when there is no number', async () => {
    const out = await new SmsChannel(providers(), prismaWith(null)).deliver(msg());
    expect(out).toMatchObject({ skipped: true, reason: 'no_destination' });
  });

  it('WhatsApp does the same', async () => {
    const out = await new WhatsAppChannel(providers(), prismaWith(null)).deliver(
      msg({ channel: 'whatsapp' }),
    );
    expect(out).toMatchObject({ skipped: true, reason: 'no_destination' });
  });

  it('SMS delivers to the account number when there is one', async () => {
    const out = await new SmsChannel(providers(), prismaWith('+919876543210')).deliver(msg());
    // No market table configured here, so it routes to the log transport and reports it.
    expect(out).toMatchObject({ provider: 'log' });
    expect(out.skipped).toBeUndefined();
  });
});
