import { FailureClass, SuppressionReason } from '@eticketsgo/shared-types';
import { SmsChannel } from './sms.channel';
import { TransportError } from './transports/transport-http';
import type { SmsTransport } from './transports/sms.transport';
import type { RenderedNotification } from './notification-channel.interface';

/**
 * What the SMS channel remembers about opt-outs.
 *
 * A STOP reaches the provider, never this platform. The channel learns about it in exactly two
 * ways -- the provider refusing a send, and the provider accepting one after a START -- and
 * both are recorded here, where the destination is known, so every path that texts a number
 * sees the same answer.
 */

const PHONE = '+14155550123';

function build(transport: Partial<SmsTransport> & Pick<SmsTransport, 'send'>) {
  const suppression = {
    suppress: jest.fn().mockResolvedValue(undefined),
    liftProviderOptOut: jest.fn().mockResolvedValue(true),
  };
  const providers = {
    routeSms: () => ({
      ok: true,
      provider: transport.name ?? 'twilio',
      market: 'US',
      transport: { name: 'twilio', ...transport },
    }),
  };
  const channel = new SmsChannel(providers as never, undefined, suppression as never);
  return { channel, suppression };
}

const msg = (): RenderedNotification => ({
  type: 'ACCOUNT_SECURITY' as never,
  channel: 'sms',
  locale: 'en',
  subject: 'Your sign-in code',
  body: 'code',
  payload: { phone: PHONE },
});

describe('the SMS channel and opt-outs', () => {
  it('records a STOP refusal as an unsubscribe, and still fails the send', async () => {
    const stop = new TransportError(
      'twilio error 21610: unsubscribed',
      'twilio',
      FailureClass.COMPLIANCE_BLOCKED,
      400,
      {
        providerCode: '21610',
        suppression: SuppressionReason.UNSUBSCRIBED,
      },
    );
    const { channel, suppression } = build({ send: jest.fn().mockRejectedValue(stop) });

    await expect(channel.deliver(msg())).rejects.toBe(stop);
    expect(suppression.suppress).toHaveBeenCalledWith({
      channel: 'sms',
      destination: PHONE,
      reason: SuppressionReason.UNSUBSCRIBED,
      provider: 'twilio',
    });
  });

  it('records nothing for a failure that says nothing about the person', async () => {
    const outage = new TransportError('timed out', 'twilio', FailureClass.TEMPORARY_PROVIDER_ERROR);
    const { channel, suppression } = build({ send: jest.fn().mockRejectedValue(outage) });
    await expect(channel.deliver(msg())).rejects.toBe(outage);
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  it('lifts a recorded opt-out when a provider that enforces opt-out accepts a message', async () => {
    // The secondary repair path; the START keyword webhook is the primary one.
    const { channel, suppression } = build({
      enforcesOptOut: true,
      send: jest.fn().mockResolvedValue({ provider: 'twilio', providerMessageId: 'SM1' }),
    });
    await channel.deliver(msg());
    expect(suppression.liftProviderOptOut).toHaveBeenCalledWith('sms', PHONE, 'twilio', 'accepted');
  });

  it('does not lift anything on a transport that cannot know about opt-outs', async () => {
    // The log transport "accepts" everything; that proves nothing about the recipient.
    const { channel, suppression } = build({
      name: 'log',
      send: jest.fn().mockResolvedValue({ provider: 'log' }),
    });
    await channel.deliver(msg());
    expect(suppression.liftProviderOptOut).not.toHaveBeenCalled();
  });

  it('does not lift anything when nothing was sent', async () => {
    const { channel, suppression } = build({
      enforcesOptOut: true,
      send: jest
        .fn()
        .mockResolvedValue({ provider: 'twilio', skipped: true, reason: 'no_destination' }),
    });
    await channel.deliver(msg());
    expect(suppression.liftProviderOptOut).not.toHaveBeenCalled();
  });
});
