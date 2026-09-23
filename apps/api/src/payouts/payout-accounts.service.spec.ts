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
  const stored: Record<string, unknown>[] = [];
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    organizerPayoutAccount: {
      findMany: jest.fn(async () => stored),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          stored.find((row) => row.id === where.id) ?? null,
      ),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
        const row = { id: 'acc1', verifiedAt: null, updatedAt: new Date(), ...create };
        stored.push(row);
        return row;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...stored[0],
        ...data,
      })),
    },
  };
  const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
  const config = { get: () => key };
  return {
    service: new PayoutAccountsService(
      prisma as never,
      access as never,
      audit as never,
      config as never,
    ),
    stored,
    audit,
    access,
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

describe('saving an account', () => {
  it('stores ciphertext and a mask, never the number', async () => {
    const { service, stored } = makeService();
    const view = await service.save(owner, 'org-1', DETAILS);
    expect(view.accountLast4).toBe('6789');
    expect(JSON.stringify(view)).not.toContain('50100123456789');
    const row = stored[0] as { accountCipher: string };
    expect(row.accountCipher).not.toContain('50100123456789');
    expect(decryptAccountNumber(row.accountCipher, bankKey(KEY))).toBe('50100123456789');
  });

  it('keeps the number out of the audit log', async () => {
    const { service, audit } = makeService();
    await service.save(owner, 'org-1', DETAILS);
    expect(JSON.stringify(audit.record.mock.calls[0][0])).not.toContain('50100123456789');
  });

  it('refuses to store anything on an environment with no key', async () => {
    // Better than storing them weaker: an environment without a key simply cannot hold
    // bank details.
    const { service, stored } = makeService(null);
    await expect(service.save(owner, 'org-1', DETAILS)).rejects.toBeInstanceOf(AppException);
    expect(stored).toHaveLength(0);
  });

  it('refuses an account number that is not one', async () => {
    const { service } = makeService();
    await expect(
      service.save(owner, 'org-1', { ...DETAILS, accountNumber: '12' }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('is only the owner who may set where the money goes', async () => {
    const { service, access } = makeService();
    await service.save(owner, 'org-1', DETAILS);
    expect(access.assertMember).toHaveBeenCalledWith(owner, 'org-1', ['ORGANIZER_OWNER']);
  });
});

describe('revealing an account', () => {
  it('returns the number and records who asked and why', async () => {
    const { service, audit } = makeService();
    await service.save(owner, 'org-1', DETAILS);
    const revealed = await service.reveal(admin, 'acc1', 'Making the September transfer');
    expect(revealed.accountNumber).toBe('50100123456789');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PAYOUT_ACCOUNT_REVEALED',
        metadata: expect.objectContaining({ reason: 'Making the September transfer' }),
      }),
    );
  });

  it('refuses without a reason, because the reason is the point of the record', async () => {
    const { service } = makeService();
    await service.save(owner, 'org-1', DETAILS);
    await expect(service.reveal(admin, 'acc1', '  ')).rejects.toBeInstanceOf(AppException);
  });

  it('says it cannot read rather than guessing, under a different key', async () => {
    // An account number that decrypts to something else moves money to somebody else.
    const { service, stored } = makeService();
    await service.save(owner, 'org-1', DETAILS);
    const other = makeService(Buffer.alloc(32, 9).toString('base64'));
    (other.stored as unknown[]).push(stored[0]);
    await expect(other.service.reveal(admin, 'acc1', 'transfer')).rejects.toBeInstanceOf(
      AppException,
    );
  });
});
