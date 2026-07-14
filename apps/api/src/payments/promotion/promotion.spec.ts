import {
  evaluatePromotion,
  expectedMode,
  isValidPromotionEdge,
  remapSecretRef,
  type PromotionFacts,
} from './promotion.logic';
import { PromotionService } from './promotion.service';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service';
import { PaymentProviderFactory } from '../provider/factory/payment-provider.factory';
import type { SecretManager } from '../../secrets/secret-manager.interface';
import { AppException } from '../../common/errors';

describe('promotion logic', () => {
  it('validates the forward path only', () => {
    expect(isValidPromotionEdge('UAT', 'STAGING')).toBe(true);
    expect(isValidPromotionEdge('STAGING', 'PRODUCTION')).toBe(true);
    expect(isValidPromotionEdge('DEV', 'PRODUCTION')).toBe(false);
    expect(isValidPromotionEdge('PRODUCTION', 'STAGING')).toBe(false);
  });

  it('remaps secret references to the target env token', () => {
    expect(remapSecretRef('payments/stripe/test/secret-key', 'PRODUCTION')).toBe(
      'payments/stripe/production/secret-key',
    );
    expect(remapSecretRef('payments/stripe/test/secret-key', 'STAGING')).toBe(
      'payments/stripe/staging/secret-key',
    );
    expect(remapSecretRef('payments/stripe/live/secret-key', 'UAT')).toBe(
      'payments/stripe/test/secret-key',
    );
  });

  it('expected mode is LIVE only for staging/production', () => {
    expect(expectedMode('PRODUCTION')).toBe('LIVE');
    expect(expectedMode('STAGING')).toBe('LIVE');
    expect(expectedMode('UAT')).toBe('TEST');
  });

  const goodProdFacts: PromotionFacts = {
    fromEnv: 'STAGING',
    toEnv: 'PRODUCTION',
    provider: 'stripe',
    sourceEnabled: true,
    isDummy: false,
    secretRefsPresent: true,
    secretManagerHealthy: true,
    secretsResolvable: true,
    webhookConfigured: true,
    apiBaseUrl: null,
    classified: 'live',
    routeExistsInTarget: true,
    merchantVerifiedInTarget: true,
    providerHealthPassing: true,
    allowLiveKeysInLowerEnv: false,
  };

  it('passes a fully valid production promotion', () => {
    expect(evaluatePromotion(goodProdFacts).ok).toBe(true);
  });

  it('blocks a test key going to production', () => {
    const r = evaluatePromotion({ ...goodProdFacts, classified: 'test' });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.key === 'no-test-keys-in-prod')?.passed).toBe(false);
  });

  it('blocks the dummy provider and a missing route', () => {
    expect(evaluatePromotion({ ...goodProdFacts, isDummy: true }).ok).toBe(false);
    expect(evaluatePromotion({ ...goodProdFacts, routeExistsInTarget: false }).ok).toBe(false);
  });

  it('blocks a live key promoted to a lower env unless allowed', () => {
    const facts: PromotionFacts = {
      ...goodProdFacts,
      fromEnv: 'QA',
      toEnv: 'UAT',
      classified: 'live',
    };
    expect(evaluatePromotion(facts).ok).toBe(false);
    expect(evaluatePromotion({ ...facts, allowLiveKeysInLowerEnv: true }).ok).toBe(true);
  });
});

// ── Service (approval workflow) ───────────────────────────────────────────────
function makeService(reqRow: Record<string, unknown> | null) {
  const prisma = {
    paymentProviderConfig: {
      findUnique: jest.fn().mockResolvedValue({
        env: 'STAGING',
        provider: 'stripe',
        enabled: true,
        mode: 'LIVE',
        publicKey: 'pk_live_x',
        secretKeyRef: 'payments/stripe/staging/secret-key',
        webhookSecretRef: 'payments/stripe/staging/webhook-secret',
        apiBaseUrl: null,
        priority: 100,
      }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    paymentRoute: { count: jest.fn().mockResolvedValue(1) },
    merchantOnboarding: { count: jest.fn().mockResolvedValue(1) },
    promotionRequest: {
      create: jest.fn((a: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'p1', ...a.data }),
      ),
      findUnique: jest.fn().mockResolvedValue(reqRow),
      update: jest.fn((a: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...reqRow, ...a.data }),
      ),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const config = { get: () => 'false' } as unknown as ConfigService;
  const secrets: SecretManager = {
    provider: 'fake',
    getSecret: jest.fn().mockResolvedValue('sk_live_ok'),
    getSecrets: jest.fn(),
    validateReference: () => true,
    healthCheck: jest.fn().mockResolvedValue({ healthy: true, provider: 'fake' }),
    invalidateCache: jest.fn(),
  };
  const factory = {
    buildEphemeral: jest.fn().mockResolvedValue({
      healthCheck: jest.fn().mockResolvedValue({ healthy: true }),
    }),
  } as unknown as PaymentProviderFactory;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { svc: new PromotionService(prisma as any, audit, config, secrets, factory), prisma };
}

const prodRequest = {
  id: 'p1',
  provider: 'stripe',
  fromEnv: 'STAGING',
  toEnv: 'PRODUCTION',
  status: 'PENDING_APPROVAL',
  requiredApprovals: 2,
  report: { ok: true, checks: [] },
  approvals: [],
  requestedByUserId: 'requester',
};

describe('PromotionService approval workflow', () => {
  it('production needs two distinct approvers (not the requester)', async () => {
    const { svc } = makeService(prodRequest);
    await expect(svc.approve('p1', { userId: 'requester' })).rejects.toBeInstanceOf(AppException);
  });

  it('stays pending after the first approval, approved after the second', async () => {
    let row: Record<string, unknown> = { ...prodRequest };
    const { svc, prisma } = makeService(row);
    (prisma.promotionRequest.findUnique as jest.Mock).mockImplementation(() =>
      Promise.resolve(row),
    );
    (prisma.promotionRequest.update as jest.Mock).mockImplementation(
      (a: { data: Record<string, unknown> }) => {
        row = { ...row, ...a.data };
        return Promise.resolve(row);
      },
    );
    const first = await svc.approve('p1', { userId: 'approver1' });
    expect(first.status).toBe('PENDING_APPROVAL');
    const second = await svc.approve('p1', { userId: 'approver2' });
    expect(second.status).toBe('APPROVED');
  });

  it('the same approver cannot approve twice', async () => {
    const row = { ...prodRequest, approvals: [{ userId: 'approver1', at: 'x' }] };
    const { svc } = makeService(row);
    await expect(svc.approve('p1', { userId: 'approver1' })).rejects.toBeInstanceOf(AppException);
  });

  it('apply refuses a non-approved promotion', async () => {
    const { svc } = makeService({ ...prodRequest, status: 'PENDING_APPROVAL' });
    await expect(svc.apply('p1', { userId: 'admin' })).rejects.toBeInstanceOf(AppException);
  });

  it('apply writes a disabled target config and marks APPLIED', async () => {
    const { svc, prisma } = makeService({ ...prodRequest, status: 'APPROVED' });
    const row = await svc.apply('p1', { userId: 'admin' });
    expect(prisma.paymentProviderConfig.upsert).toHaveBeenCalled();
    const call = (prisma.paymentProviderConfig.upsert as jest.Mock).mock.calls[0][0];
    expect(call.create.enabled).toBe(false); // never auto-enabled
    expect(row.status).toBe('APPLIED');
  });
});
