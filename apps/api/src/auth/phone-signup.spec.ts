import { AuthService } from './auth.service';

/**
 * Sign-UP by mobile: what the Mobile tab of /register adds to a proven number.
 *
 * The code itself is checked by PhoneOtpService before any of this runs; these are the rules
 * for the two things the form adds - a name, and the US text-message agreement.
 */
function setup(user: { fullName: string; phone: string | null } | null) {
  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(user ? { id: 'u1', email: 'phone+1@users.internal', ...user } : null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const consent = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AuthService(
    prisma as never,
    {} as never,
    { get: () => undefined } as never,
    { record: jest.fn() } as never,
    { send: async () => undefined } as never,
    consent as never,
  );
  return { service, prisma, consent };
}

describe('AuthService.applyPhoneSignup', () => {
  it('names a brand-new phone account', async () => {
    const { service, prisma } = setup({ fullName: '', phone: '+919800000001' });
    await service.applyPhoneSignup('u1', { fullName: 'Asha Menon' });
    // Conditional on the name STILL being empty, so a concurrent rename is never overwritten.
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', fullName: '' },
      data: { fullName: 'Asha Menon' },
    });
  });

  it('never renames an account that already has a name', async () => {
    /*
      The sign-up tab cannot say whether the number is registered (that would be an oracle),
      so an existing number simply signs in. Typing a name there must not rename the account.
    */
    const { service, prisma } = setup({ fullName: 'Riya Rao', phone: '+919800000001' });
    await service.applyPhoneSignup('u1', { fullName: 'Somebody Else' });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('records the US agreement as a SIGNUP consent against the proven number', async () => {
    const { service, consent } = setup({ fullName: '', phone: '+14155550132' });
    await service.applyPhoneSignup('u1', { fullName: 'Sam Lee', smsConsent: true, country: 'US' });
    expect(consent.record).toHaveBeenCalledTimes(1);
    const [subject, scope, granted, evidence] = consent.record.mock.calls[0];
    expect(subject).toEqual({ userId: 'u1', email: 'phone+1@users.internal' });
    // Transactional only: the box promises booking messages, never marketing.
    expect(scope).toBe('sms:transactional');
    expect(granted).toBe(true);
    expect(evidence).toEqual(
      expect.objectContaining({ source: 'CUSTOMER_SIGNUP', phone: '+14155550132' }),
    );
  });

  it('writes no consent when the box was not ticked', async () => {
    const { service, consent } = setup({ fullName: '', phone: '+14155550132' });
    await service.applyPhoneSignup('u1', { fullName: 'Sam Lee' });
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('does nothing at all for a plain sign-in', async () => {
    const { service, prisma } = setup({ fullName: '', phone: '+14155550132' });
    await service.applyPhoneSignup('u1', {});
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('does not fail the sign-in when the name cannot be saved', async () => {
    const { service, prisma } = setup({ fullName: '', phone: '+14155550132' });
    prisma.user.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(service.applyPhoneSignup('u1', { fullName: 'Sam Lee' })).resolves.toBeUndefined();
  });
});
