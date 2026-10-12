import { FailureClass } from '@eticketsgo/shared-types';
import { SmsChannel } from './sms.channel';
import { TransportError } from './transports/transport-http';

/** SMS_ENABLED=false: an SMS send fails loudly and permanently, never a silent SENT. */
describe('the SMS channel when SMS is declared off', () => {
  const routeSms = jest.fn();
  const build = (enabled: string) =>
    new SmsChannel({ routeSms } as never, undefined, undefined, {
      get: (k: string) => (k === 'SMS_ENABLED' ? enabled : undefined),
    } as never);
  const msg = {
    type: 'ACCOUNT_SECURITY' as never,
    channel: 'sms' as const,
    locale: 'en',
    subject: 's',
    body: 'b',
    payload: { phone: '+919876543210' },
  };

  it('throws a permanent configuration failure and never calls a provider', async () => {
    const err = await build('false')
      .deliver(msg as never)
      .catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.failureClass).toBe(FailureClass.CONFIGURATION_ERROR);
    expect(routeSms).not.toHaveBeenCalled();
  });

  it('behaves as before when SMS is enabled', async () => {
    routeSms.mockReturnValue({ ok: false, refusal: 'no_route', market: null });
    await expect(build('true').deliver(msg as never)).rejects.toThrow(/No SMS provider/);
    expect(routeSms).toHaveBeenCalled();
  });
});
