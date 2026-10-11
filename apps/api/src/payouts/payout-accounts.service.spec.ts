import { PayoutAccountsService } from './payout-accounts.service';
import { bankKey, decryptAccountNumber, encryptAccountNumber, last4 } from './bank-secret';
import { AppException } from '../common/errors';

/**
 * An organizer's bank account, which the platform has to hold while a person is the one
 * making the transfers.
 *
 * The number is the only thing here that matters: it must never be stored in the clear,
 * never be returned by an ordinary read, never reach the audit log, and never be readable
 * on an environment with no key. Revealing it is an event, not a read.
 */
const KEY = Buffer.alloc(32, 7).toString('base64');
const owner = { id: 'u-owner', email: 'o@t.test', fullName: 'O', roles: [] } as never;
const admin = { id: 'u-admin', email: 'a@t.test', fullName: 'A', roles: [] } as never;

function makeService(key: string | null = KEY) {
  // Validation and key handling all happen BEFORE the database is touched, so these tests use a
  // prisma that fails loudly if anything reaches it. The persisted behaviour (versions, the
  // maker-checker, notifications) is covered against real Postgres in
  // payout-account-safeguards.integration-postgres.spec.ts.
  const prisma = new Proxy(
    {},
    {
      get() {
        throw new Error('the database must not be reached');
      },
    },
  );
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const config = { get: () => key };
  const audience = { notifyOrganizationOwners: jest.fn() };
  return {
    service: new PayoutAccountsService(
      prisma as never,
      access as never,
      audit as never,
      config as never,
      audience as never,
    ),
    audit,
    access,
    audience,
  };
}

const DETAILS = {
  currency: 'inr',
  holderName: 'Bengaluru Live Pvt Ltd',
  bankName: 'HDFC Bank',
  bankCode: 'hdfc0001234',
  accountNumber: '5010 0123 4567 89',
};

describe('the account number at rest', () => {
  it('round-trips through encryption', () => {
    const key = bankKey(KEY);
    const cipher = encryptAccountNumber('501001234567', key);
    expect(cipher).not.toContain('501001234567');
    expect(decryptAccountNumber(cipher, key)).toBe('501001234567');
  });

  it('produces different ciphertext for the same number twice', () => {
    // Two organizers with the same account number must not produce the same ciphertext,
    // which would say they are the same account without decrypting anything.
    const key = bankKey(KEY);
    expect(encryptAccountNumber('501001234567', key)).not.toBe(
      encryptAccountNumber('501001234567', key),
    );
  });

  it('refuses to decrypt something that has been altered', () => {
    const key = bankKey(KEY);
    const cipher = encryptAccountNumber('501001234567', key);
    const [iv, tag] = cipher.split(':');
    const tampered = [iv, tag, Buffer.from('999999999999').toString('base64')].join(':');
    expect(() => decryptAccountNumber(tampered, key)).toThrow();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => bankKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/);
  });

  it('masks to the last four digits', () => {
    expect(last4('5010 0123 4567 89')).toBe('6789');
  });
});

describe('refusals that happen before anything is stored', () => {
  it('refuses to store anything on an environment with no key', async () => {
    // Better than storing them weaker: an environment without a key simply cannot hold
    // bank details. The proxy would throw if the save went on to touch the database.
    const { service, audience } = makeService(null);
    await expect(service.save(owner, 'org-1', DETAILS)).rejects.toBeInstanceOf(AppException);
    expect(audience.notifyOrganizationOwners).not.toHaveBeenCalled();
  });

  it('refuses an account number that is not one', async () => {
    const { service } = makeService();
    await expect(
      service.save(owner, 'org-1', { ...DETAILS, accountNumber: '12' }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('is only the owner who may set where the money goes', async () => {
    const { service, access } = makeService();
    // The proxy throws once the save reaches the database, which is after the owner check.
    await service.save(owner, 'org-1', DETAILS).catch(() => undefined);
    expect(access.assertMember).toHaveBeenCalledWith(owner, 'org-1', ['ORGANIZER_OWNER']);
  });

  it('a reveal refuses without a reason, because the reason is the point of the record', async () => {
    const { service } = makeService();
    await expect(service.reveal(admin, 'acc1', '  ')).rejects.toBeInstanceOf(AppException);
  });

  it('a reveal or a rejection refuses a reason that carries an account number', async () => {
    const { service } = makeService();
    await expect(service.reveal(admin, 'acc1', 'for 5010 0123 4567')).rejects.toBeInstanceOf(
      AppException,
    );
    await expect(service.reject(admin, 'acc1', 'wrong: 501001234567', 1)).rejects.toBeInstanceOf(
      AppException,
    );
  });
});
