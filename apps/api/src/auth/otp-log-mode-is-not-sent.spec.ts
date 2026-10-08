import { PhoneOtpService } from './phone-otp.service';

/**
 * A log-mode send is not a send.
 *
 * -- THE PRODUCTION DEFECT THIS CLOSES --------------------------------------------------
 * `SmsLogTransport` writes a line and returns `{ provider: 'log' }`, which is a SUCCESS and
 * indistinguishable from a real delivery to everything above it. Production had no Twilio
 * credentials, so `SMS_PROVIDER` fell back to `log`, and the whole sign-in became something
 * a person could not detect was broken: the API answered 201, the screen said "Code sent to
 * +1...", and the text message was never going to arrive. Observed on production
 * 2026-10-07:
 *
 *   POST /api/auth/phone/request-code -> 201
 *   [sms:ACCOUNT_SECURITY] not sent (SMS is in log mode); content withheld -> +1***40
 *
 * -- WHY LOCAL AND DEV ARE DIFFERENT ----------------------------------------------------
 * There the console IS the delivery channel - printing the code is how a developer signs in
 * without a provider account. So the rule is the same predicate the log transport uses to
 * decide whether to print the body, deliberately, so the two cannot disagree.
 */
describe('a sign-in code that was never sent', () => {
  function makeService(env: { APP_ENV: string; NODE_ENV?: string }, provider: string) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      phoneOtp: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({}),
        updateMany,
      },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const sms = { deliver: jest.fn().mockResolvedValue({ provider }) };
    const config = {
      get: (k: string) => (env as Record<string, string | undefined>)[k],
    };
    const service = new PhoneOtpService(prisma as never, sms as never, config as never);
    return { service, sms, updateMany };
  }

  const PROD = { APP_ENV: 'PRODUCTION', NODE_ENV: 'production' };
  const LOCAL = { APP_ENV: 'LOCAL', NODE_ENV: 'development' };

  it('refuses to report a code as sent when production is in log mode', async () => {
    const { service } = makeService(PROD, 'log');
    await expect(service.requestCode('+15551234567')).rejects.toMatchObject({
      // Says the channel is unavailable and points at email, rather than claiming success.
      message: expect.stringContaining('email address'),
    });
  });

  it('consumes the code it could not deliver, so nothing stays redeemable', async () => {
    /*
      A code nobody received must not remain valid. Leaving it live would mean a secret
      sitting in the database with no owner, for as long as its TTL.
    */
    const { service, updateMany } = makeService(PROD, 'log');
    await service.requestCode('+15551234567').catch(() => undefined);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ consumedAt: expect.any(Date) }) }),
    );
  });

  it('still reports sent when a real provider handled it', async () => {
    // The fix must not break the working case: a provider that accepted the message is a send.
    const { service } = makeService(PROD, 'twilio');
    await expect(service.requestCode('+15551234567')).resolves.toMatchObject({ sent: true });
  });

  it('treats a skipped delivery as not sent either', async () => {
    const { service } = makeService(PROD, 'twilio');
    const svc = service as unknown as { sms: { deliver: jest.Mock } };
    svc.sms.deliver = jest.fn().mockResolvedValue({ provider: 'none', skipped: true });
    await expect(service.requestCode('+15551234567')).rejects.toBeDefined();
  });

  it('LOCAL keeps working, because there the console is the delivery channel', async () => {
    const { service } = makeService(LOCAL, 'log');
    await expect(service.requestCode('+15551234567')).resolves.toMatchObject({ sent: true });
  });
});
