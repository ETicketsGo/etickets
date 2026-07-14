import {
  canTransition,
  isActivationReady,
  isEditable,
  onboardingChecklist,
} from './merchant-onboarding.checklist';
import { MerchantOnboardingService } from './merchant-onboarding.service';
import { AuditService } from '../../audit/audit.service';
import { PaymentProviderFactory } from '../provider/factory/payment-provider.factory';
import { AppException } from '../../common/errors';

const complete = {
  country: 'US',
  legalBusinessName: 'Acme LLC',
  displayName: 'Acme',
  settlementCurrency: 'USD',
  provider: 'stripe',
  accountIdentifier: 'acct_123',
  secretKeyRef: 'payments/stripe/live/secret-key',
  webhookSecretRef: 'payments/stripe/live/webhook-secret',
  payoutDestinationRef: 'ba_ref_1',
  webhookEndpointStatus: 'VERIFIED',
  verificationStatus: 'VERIFIED',
  termsAcceptedAt: new Date(),
};

describe('onboarding checklist', () => {
  it('is activation-ready when all blocking items are done', () => {
    expect(isActivationReady(complete)).toBe(true);
  });
  it('is not ready when verification is missing', () => {
    expect(isActivationReady({ ...complete, verificationStatus: 'UNVERIFIED' })).toBe(false);
  });
  it('flags invalid secret references', () => {
    const items = onboardingChecklist({ ...complete, secretKeyRef: 'not a ref' });
    expect(items.find((i) => i.key === 'secretRefs')?.done).toBe(false);
  });
  it('payout is non-blocking', () => {
    const items = onboardingChecklist({ ...complete, payoutDestinationRef: null });
    expect(items.find((i) => i.key === 'payout')?.blocking).toBe(false);
    expect(isActivationReady({ ...complete, payoutDestinationRef: null })).toBe(true);
  });
});

describe('transition rules', () => {
  it('permits the happy path', () => {
    expect(canTransition('DRAFT', 'PENDING_CONFIGURATION')).toBe(true);
    expect(canTransition('READY_FOR_LIVE', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'SUSPENDED')).toBe(true);
  });
  it('forbids skipping states', () => {
    expect(canTransition('DRAFT', 'ACTIVE')).toBe(false);
    expect(canTransition('REJECTED', 'ACTIVE')).toBe(false);
  });
  it('editable only before verification', () => {
    expect(isEditable('DRAFT')).toBe(true);
    expect(isEditable('TESTING')).toBe(false);
  });
});

function makeService(record: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  const prisma = {
    merchantOnboarding: {
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'o1', ...args.data }),
      ),
      findUnique: jest.fn().mockResolvedValue(record),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...record, ...args.data }),
      ),
    },
    paymentProviderConfig: {
      findUnique: jest.fn().mockResolvedValue('config' in extra ? extra.config : { id: 'cfg1' }),
    },
    merchantAccount: {
      upsert: jest.fn().mockResolvedValue({ id: 'ma1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const factory = {
    buildEphemeral: jest.fn().mockResolvedValue({
      healthCheck: jest.fn().mockResolvedValue({ healthy: true, mode: 'live' }),
    }),
  } as unknown as PaymentProviderFactory;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    svc: new MerchantOnboardingService(prisma as any, audit, factory),
    prisma,
    audit,
    factory,
  };
}

const activeRecord = {
  id: 'o1',
  env: 'PRODUCTION',
  status: 'READY_FOR_LIVE',
  mode: 'LIVE',
  ...complete,
};

describe('MerchantOnboardingService', () => {
  it('create audits the creation', async () => {
    const { svc, audit } = makeService(null);
    await svc.create(
      {
        env: 'UAT',
        country: 'us',
        legalBusinessName: 'Acme',
        displayName: 'Acme',
        settlementCurrency: 'usd',
        provider: 'stripe',
      },
      { userId: 'u1' },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MERCHANT_ONBOARDING_CREATED' }),
    );
  });

  it('rejects editing a non-editable record', async () => {
    const { svc } = makeService({ ...activeRecord, status: 'TESTING' });
    await expect(svc.update('o1', { displayName: 'x' }, { userId: 'u1' })).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('rejects an illegal transition', async () => {
    const { svc } = makeService({ ...activeRecord, status: 'DRAFT' });
    await expect(svc.transition('o1', 'ACTIVE' as never, { userId: 'u1' })).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('activate creates a merchant account and marks ACTIVE', async () => {
    const { svc, prisma } = makeService(activeRecord);
    const row = await svc.activate('o1', { userId: 'u1' });
    expect(prisma.merchantAccount.upsert).toHaveBeenCalled();
    expect(row.status).toBe('ACTIVE');
    expect(row.merchantAccountId).toBe('ma1');
  });

  it('activate fails when not activation-ready', async () => {
    const { svc } = makeService({ ...activeRecord, verificationStatus: 'UNVERIFIED' });
    await expect(svc.activate('o1', { userId: 'u1' })).rejects.toBeInstanceOf(AppException);
  });

  it('activate fails closed when no provider config exists', async () => {
    const { svc } = makeService(activeRecord, { config: null });
    await expect(svc.activate('o1', { userId: 'u1' })).rejects.toBeInstanceOf(AppException);
  });

  it('suspend deactivates the linked merchant account', async () => {
    const { svc, prisma } = makeService({
      ...activeRecord,
      status: 'ACTIVE',
      merchantAccountId: 'ma1',
    });
    await svc.suspend('o1', 'fraud review', { userId: 'u1' });
    expect(prisma.merchantAccount.update).toHaveBeenCalledWith({
      where: { id: 'ma1' },
      data: { active: false },
    });
  });

  it('testConnection builds an ephemeral provider from the merchant refs', async () => {
    const { svc, factory } = makeService(activeRecord);
    const res = await svc.testConnection('o1', { userId: 'u1' });
    expect(factory.buildEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'stripe', env: 'PRODUCTION' }),
    );
    expect(res.healthy).toBe(true);
  });
});
