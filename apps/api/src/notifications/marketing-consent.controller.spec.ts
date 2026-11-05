import { MarketingConsentController } from './marketing-consent.controller';

/*
  Texts about bookings are agreed for the account's proved number. With none on file the
  grant is refused with a reason, instead of recording a consent the send would never accept.
*/
describe('MarketingConsentController sms:transactional', () => {
  const user = { id: 'u1', email: 'a@b.test' } as never;
  const make = (verifiedPhone: string | null) => {
    const consent = {
      verifiedPhone: jest.fn().mockResolvedValue(verifiedPhone),
      record: jest.fn().mockResolvedValue(undefined),
      stateFor: jest.fn().mockResolvedValue([]),
    };
    return { consent, controller: new MarketingConsentController(consent as never) };
  };

  it('refuses a grant when the account has no verified number', async () => {
    const { consent, controller } = make(null);
    await expect(
      controller.update(user, { channel: 'sms:transactional', granted: true }, '127.0.0.1'),
    ).rejects.toThrow(/Verify your mobile number first/);
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('records a grant when the number is verified', async () => {
    const { consent, controller } = make('+14155550100');
    await controller.update(user, { channel: 'sms:transactional', granted: true }, '127.0.0.1');
    expect(consent.record).toHaveBeenCalledWith(
      expect.anything(),
      'sms:transactional',
      true,
      expect.objectContaining({ source: 'account-settings:sms:transactional' }),
    );
  });

  it('always lets a person withdraw, verified number or not', async () => {
    const { consent, controller } = make(null);
    await controller.update(user, { channel: 'sms:transactional', granted: false }, '127.0.0.1');
    expect(consent.record).toHaveBeenCalledWith(
      expect.anything(),
      'sms:transactional',
      false,
      expect.anything(),
    );
  });
});
