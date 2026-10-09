import { UsersService } from './users.service';

/**
 * unit - the API never hands a phone-only account's placeholder address to the browser.
 *
 * It was shown in the account menu as "phone+14695884580@users.eticketsgo.internal". The
 * honest answer is that the account has no email address yet: `null`.
 */
describe('UsersService and placeholder addresses', () => {
  const row = (email: string) => ({
    id: 'u1',
    email,
    fullName: '',
    roles: ['CUSTOMER'],
    status: 'ACTIVE',
    createdAt: new Date(),
    memberships: [],
  });
  const service = (email: string) =>
    new UsersService({
      user: {
        findUnique: jest.fn().mockResolvedValue(row(email)),
        update: jest.fn().mockResolvedValue(row(email)),
      },
    } as never);

  it('returns no email for a phone-only account', async () => {
    const svc = service('phone+14695884580@users.eticketsgo.internal');
    expect((await svc.profile('u1')).email).toBeNull();
    expect((await svc.updateProfile('u1', 'Srinivas')).email).toBeNull();
  });

  it('returns a real email unchanged', async () => {
    expect((await service('riya@example.com').profile('u1')).email).toBe('riya@example.com');
  });
});
