import { EmailChannel, isSpecialUseEmailDomain } from './email.channel';

/**
 * unit - mail is never sent to a phone-only account's placeholder address.
 *
 * Sending there bounces, and bounces count against the sender's reputation - which is what
 * decides whether everybody else's tickets land in an inbox. Skipped, not failed: nothing to
 * retry.
 */
describe('EmailChannel and placeholder addresses', () => {
  const transport = {
    name: 'ses',
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
    const out = await channel.deliver(msg('riya@gmail.com'));
    expect(out).toMatchObject({ provider: 'ses' });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});

describe('EmailChannel and domains that cannot receive mail', () => {
  const msg = (toEmail: string) =>
    ({ type: 'BOOKING_CONFIRMED', toEmail, subject: 's', body: 'b', payload: {} }) as never;

  it.each([
    'qa-buyer@eticketsgo.test',
    'someone@example.com',
    'a@mail.example.org',
    'x@foo.invalid',
    'y@host.localhost',
    'z@shop.example',
  ])('skips %s with a real provider, without calling it', async (address) => {
    const send = jest.fn();
    const out = await new EmailChannel({ name: 'ses', send } as never).deliver(msg(address));
    expect(out).toMatchObject({ provider: 'none', skipped: true, reason: 'no_deliverable_email' });
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves the log transport alone, so local and test runs are unchanged', async () => {
    const send = jest.fn().mockResolvedValue({ provider: 'log' });
    const out = await new EmailChannel({ name: 'log', send } as never).deliver(
      msg('qa-buyer@eticketsgo.test'),
    );
    expect(out).toMatchObject({ provider: 'log' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['riya@gmail.com', 'ops@example-tickets.com', 'me@contest.in', 'a@test.com'])(
    'does not mistake %s for a reserved domain',
    (address) => {
      expect(isSpecialUseEmailDomain(address)).toBe(false);
    },
  );
});
