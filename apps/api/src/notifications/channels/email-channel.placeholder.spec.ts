import { EmailChannel } from './email.channel';

/**
 * unit - mail is never sent to a phone-only account's placeholder address.
 *
 * Sending there bounces, and bounces count against the sender's reputation - which is what
 * decides whether everybody else's tickets land in an inbox. Skipped, not failed: nothing to
 * retry.
 */
describe('EmailChannel and placeholder addresses', () => {
  const transport = {
    send: jest.fn().mockResolvedValue({ provider: 'ses', providerMessageId: 'm1' }),
  };
  const channel = new EmailChannel(transport as never);
  const msg = (toEmail: string) =>
    ({ type: 'BOOKING_CONFIRMED', toEmail, subject: 's', body: 'b', payload: {} }) as never;

  beforeEach(() => transport.send.mockClear());

  it('skips a placeholder recipient without calling the provider', async () => {
    const out = await channel.deliver(msg('phone+14695884580@users.eticketsgo.internal'));
    expect(out).toMatchObject({ skipped: true, reason: 'no_deliverable_email' });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('still sends to a real address', async () => {
    const out = await channel.deliver(msg('riya@example.com'));
    expect(out).toMatchObject({ provider: 'ses' });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});
