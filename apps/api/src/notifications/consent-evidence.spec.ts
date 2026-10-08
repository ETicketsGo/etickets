import { MarketingConsentService } from './marketing-consent.service';

/**
 * What a consent record has to be able to prove.
 *
 * A checkbox is not evidence. "Somebody ticked something at some point" cannot answer the
 * only questions that matter afterwards: who, for which number, against which disclosure,
 * under which country's rules, and how. These tests pin each of those to the row.
 */
describe('consent evidence', () => {
  function makeService(user: { phone: string | null; phoneVerifiedAt: Date | null } | null = null) {
    const create = jest.fn().mockResolvedValue({});
    const prisma = {
      marketingConsent: { create },
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    };
    return { service: new MarketingConsentService(prisma as never), create, prisma };
  }

  const subject = { userId: 'u1', email: 'Buyer@Example.com' };

  it('records the market and the exact disclosure version that was shown', async () => {
    const { service, create } = makeService();
    await service.record(subject, 'email', true, {
      source: 'account-settings:email',
      country: 'US',
      policyVersion: 'PRIVACY/US/v1',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          granted: true,
          country: 'US',
          policyVersion: 'PRIVACY/US/v1',
          source: 'account-settings:email',
        }),
      }),
    );
  });

  it('lower-cases the subject so the same person is one subject', async () => {
    const { service, create } = makeService();
    await service.record(subject, 'email', true, { source: 's' });
    expect(create.mock.calls[0][0].data.email).toBe('buyer@example.com');
  });

  describe('the number an SMS consent is about', () => {
    it("snapshots the account's VERIFIED number", async () => {
      const { service, create } = makeService({
        phone: '+15551234567',
        phoneVerifiedAt: new Date(),
      });
      await service.record(subject, 'sms', true, { source: 'account-settings:sms' });
      expect(create.mock.calls[0][0].data.phone).toBe('+15551234567');
    });

    it('records NO number when the account never verified one', async () => {
      /*
        The distinction the whole field rests on. An unverified number is not evidence that
        this person agreed for that number - anyone can type anyone's. No number recorded is
        the honest row.
      */
      const { service, create } = makeService({ phone: '+15551234567', phoneVerifiedAt: null });
      await service.record(subject, 'sms', true, { source: 'account-settings:sms' });
      expect(create.mock.calls[0][0].data.phone).toBeNull();
    });

    it('never takes the number from the caller for a channel that has no number', async () => {
      // An email consent has no number, and storing one there would be collecting a phone
      // number for no reason at all.
      const { service, create } = makeService({
        phone: '+15551234567',
        phoneVerifiedAt: new Date(),
      });
      await service.record(subject, 'email', true, {
        source: 's',
        phone: '+15559999999',
      });
      expect(create.mock.calls[0][0].data.phone).toBeNull();
    });

    it('does not look an account up for a channel that has no number', async () => {
      const { service, prisma } = makeService();
      await service.record(subject, 'email', true, { source: 's' });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('what is NOT consent', () => {
    it('writes nothing at all when there is no stable subject', async () => {
      /*
        A row that cannot be matched to a person later looks like evidence and proves
        nothing, which is worse than no row.
      */
      const { service, create } = makeService();
      await service.record({ userId: null, email: null }, 'sms', true, { source: 's' });
      expect(create).not.toHaveBeenCalled();
    });

    it('is append-only: a withdrawal is a new row, never an update', async () => {
      const { service, create, prisma } = makeService();
      await service.record(subject, 'sms', true, { source: 'account-settings:sms' });
      await service.record(subject, 'sms', false, { source: 'withdrawn-by-user:sms' });
      expect(create).toHaveBeenCalledTimes(2);
      expect((prisma.marketingConsent as Record<string, unknown>).update).toBeUndefined();
      expect(create.mock.calls[1][0].data.granted).toBe(false);
    });
  });
});
