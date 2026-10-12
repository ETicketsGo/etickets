import { PhoneOtpService } from './phone-otp.service';

describe('phone sign-in when SMS is declared off', () => {
  it('refuses with SMS_UNAVAILABLE before writing any code or calling the channel', async () => {
    const prisma = { phoneOtp: { count: jest.fn(), create: jest.fn(), updateMany: jest.fn() } };
    const sms = { deliver: jest.fn() };
    const config = { get: (k: string) => (k === 'SMS_ENABLED' ? 'false' : undefined) };
    const service = new PhoneOtpService(prisma as never, sms as never, config as never);
    await expect(service.requestCode('+919876543210')).rejects.toMatchObject({
      status: 503,
    });
    expect(prisma.phoneOtp.create).not.toHaveBeenCalled();
    expect(sms.deliver).not.toHaveBeenCalled();
  });
});
