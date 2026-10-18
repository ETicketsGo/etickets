import { NotificationType } from '@eticketsgo/shared-types';
import { EmailChannel } from './email.channel';
import type { RenderedNotification } from './notification-channel.interface';
import type { EmailTransport } from './transports/email.transport';
import { isSafeReplyTo, replyToFor } from './reply-to';

/**
 * Reply-To is the one mail header a payload may influence, and only for the support types.
 *
 * The address comes from a public form, so this is where user input meets a header. Anything
 * that could add a second recipient or a second header - a comma, angle brackets, a CR/LF - is
 * refused outright rather than cleaned up into something plausible.
 */
describe('replyToFor', () => {
  it('gives the support mailbox copy and the acknowledgement their Reply-To', () => {
    expect(
      replyToFor(NotificationType.SUPPORT_REQUEST_RECEIVED, { replyTo: 'asha@gmail.com' }),
    ).toBe('asha@gmail.com');
    expect(
      replyToFor(NotificationType.SUPPORT_REQUEST_ACKNOWLEDGED, {
        replyTo: 'support@eticketsgo.com',
      }),
    ).toBe('support@eticketsgo.com');
  });

  it('never lets any other type set one, whatever its payload says', () => {
    for (const type of [
      NotificationType.BOOKING_CONFIRMED,
      NotificationType.PASSWORD_RESET_REQUESTED,
      NotificationType.GUEST_BOOKING_ACCESS,
    ]) {
      expect(replyToFor(type, { replyTo: 'attacker@evil.com' })).toBeNull();
    }
  });

  it.each([
    'asha@gmail.com\r\nBcc: victim@gmail.com',
    'asha@gmail.com\nBcc: victim@gmail.com',
    'a@b.com, c@d.com',
    'Asha <asha@gmail.com>',
    '"asha"@gmail.com',
    'asha @gmail.com',
    'asha@gmail',
    '',
    `${'a'.repeat(250)}@b.com`,
    // A phone-only account's placeholder is not a mailbox.
    'phone+919876543210@users.eticketsgo.internal',
  ])('refuses %j', (value) => {
    expect(isSafeReplyTo(value)).toBe(false);
    expect(replyToFor(NotificationType.SUPPORT_REQUEST_RECEIVED, { replyTo: value })).toBeNull();
  });

  it('refuses a value that is not a string', () => {
    expect(replyToFor(NotificationType.SUPPORT_REQUEST_RECEIVED, { replyTo: ['a@b.com'] })).toBe(
      null,
    );
  });
});

describe('EmailChannel and Reply-To', () => {
  function channel() {
    const sent: RenderedNotification[] = [];
    const transport: EmailTransport = {
      name: 'log',
      send: async (m) => {
        sent.push(m);
        return { provider: 'log' };
      },
    };
    return { email: new EmailChannel(transport), sent };
  }

  const rendered = (over: Partial<RenderedNotification>): RenderedNotification => ({
    type: NotificationType.SUPPORT_REQUEST_RECEIVED,
    channel: 'email',
    locale: 'en',
    toEmail: 'support@eticketsgo.com',
    subject: 'New contact message',
    body: 'Hello',
    payload: { replyTo: 'asha@gmail.com' },
    ...over,
  });

  it('hands the transport the checked Reply-To for a support copy', async () => {
    const { email, sent } = channel();
    await email.deliver(rendered({}));
    expect(sent[0].replyTo).toBe('asha@gmail.com');
  });

  it('a payload cannot set it for any other type', async () => {
    const { email, sent } = channel();
    await email.deliver(rendered({ type: NotificationType.BOOKING_CONFIRMED }));
    expect(sent[0].replyTo).toBeNull();
  });

  it('a producer cannot pass one straight through either: the channel decides', async () => {
    const { email, sent } = channel();
    await email.deliver(
      rendered({ type: NotificationType.BOOKING_CONFIRMED, replyTo: 'attacker@evil.com' }),
    );
    expect(sent[0].replyTo).toBeNull();
  });
});
