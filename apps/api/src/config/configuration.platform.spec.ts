import { loadConfig } from './configuration';

const LOCAL_BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  QR_SIGNING_SECRET: 'c'.repeat(40),
  PAYMENT_WEBHOOK_SECRET: 'd'.repeat(40),
  APP_ENV: 'LOCAL',
  NODE_ENV: 'test',
};

// Production base that passes assertProductionHardening (real-looking secrets + CORS).
const PROD_BASE: Record<string, string> = {
  ...LOCAL_BASE,
  APP_ENV: 'PRODUCTION',
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://app.eticketsgo.example',
};

function withEnv(base: Record<string, string>, extra: Record<string, string> = {}) {
  return () => {
    const saved = process.env;
    process.env = { ...base, ...extra } as NodeJS.ProcessEnv;
    try {
      return loadConfig();
    } finally {
      process.env = saved;
    }
  };
}

describe('platform config — safe defaults', () => {
  it('loads with all platform flags unset (safe defaults)', () => {
    const cfg = withEnv(LOCAL_BASE)();
    expect(cfg.DOMAIN_EVENT_DELIVERY_MODE).toBe('in_process');
    expect(cfg.INVENTORY_LOCKS_MODE).toBe('shadow');
    expect(cfg.INVENTORY_SYNC_AUTO_REPAIR_ENABLED).toBe(false);
    expect(cfg.DOMAIN_EVENT_OUTBOX_RETENTION_ENABLED).toBe(false);
    expect(cfg.INVENTORY_SYNC_ENABLED).toBe(false);
  });

  it('loads a fully-safe production baseline (all new features off)', () => {
    expect(withEnv(PROD_BASE)).not.toThrow();
  });
});

describe('platform config — unsafe combinations fail fast', () => {
  it('rejects the mock sync provider in production', () => {
    expect(withEnv(PROD_BASE, { INVENTORY_SYNC_MOCK_PROVIDER_ENABLED: 'true' })).toThrow(
      /mock.*production/i,
    );
  });

  it('allows the mock sync provider in LOCAL', () => {
    expect(withEnv(LOCAL_BASE, { INVENTORY_SYNC_MOCK_PROVIDER_ENABLED: 'true' })).not.toThrow();
  });

  it('rejects sync enabled with an empty provider allowlist (any env)', () => {
    expect(
      withEnv(LOCAL_BASE, {
        INVENTORY_SYNC_ENABLED: 'true',
        INVENTORY_SYNC_WEBHOOKS_ENABLED: 'true',
      }),
    ).toThrow(/ALLOWLIST/i);
  });

  it('allows sync enabled when an allowlist is set', () => {
    expect(
      withEnv(LOCAL_BASE, {
        INVENTORY_SYNC_ENABLED: 'true',
        INVENTORY_SYNC_WEBHOOKS_ENABLED: 'true',
        INVENTORY_SYNC_PROVIDER_ALLOWLIST: 'mock-aggregator',
      }),
    ).not.toThrow();
  });

  it('rejects outbox mode without a dispatcher in production', () => {
    expect(withEnv(PROD_BASE, { DOMAIN_EVENT_DELIVERY_MODE: 'outbox' })).toThrow(
      /DISPATCH_ENABLED/i,
    );
  });

  it('allows outbox mode without a dispatcher in LOCAL (record-only rollout testing)', () => {
    expect(withEnv(LOCAL_BASE, { DOMAIN_EVENT_DELIVERY_MODE: 'outbox' })).not.toThrow();
  });

  it('allows outbox mode WITH a dispatcher in production', () => {
    expect(
      withEnv(PROD_BASE, {
        DOMAIN_EVENT_DELIVERY_MODE: 'outbox',
        DOMAIN_EVENT_OUTBOX_DISPATCH_ENABLED: 'true',
      }),
    ).not.toThrow();
  });

  it('rejects active inventory locking in production (not P5-wired yet)', () => {
    expect(
      withEnv(PROD_BASE, { INVENTORY_LOCKS_ENABLED: 'true', INVENTORY_LOCKS_MODE: 'active' }),
    ).toThrow(/active/i);
  });

  it('allows active-mode config in LOCAL when the orchestrator is active', () => {
    expect(
      withEnv(LOCAL_BASE, {
        BOOKING_ORCHESTRATOR_ENABLED: 'true',
        BOOKING_ORCHESTRATOR_MODE: 'active',
        INVENTORY_SOURCING_ENABLED: 'true',
        INVENTORY_LOCKS_ENABLED: 'true',
        INVENTORY_LOCKS_MODE: 'active',
      }),
    ).not.toThrow();
  });

  it('rejects active booking orchestration without inventory sourcing enabled', () => {
    expect(
      withEnv(LOCAL_BASE, {
        BOOKING_ORCHESTRATOR_ENABLED: 'true',
        BOOKING_ORCHESTRATOR_MODE: 'active',
      }),
    ).toThrow(/SOURCING/i);
  });

  it('rejects active booking orchestration on the mock payment provider in production', () => {
    expect(
      withEnv(PROD_BASE, {
        BOOKING_ORCHESTRATOR_ENABLED: 'true',
        BOOKING_ORCHESTRATOR_MODE: 'active',
        INVENTORY_SOURCING_ENABLED: 'true',
        PAYMENT_PROVIDER_NAME: 'mock',
      }),
    ).toThrow(/PAYMENT_PROVIDER_NAME/i);
  });

  it('rejects active orchestration with outbox delivery but no dispatcher in production', () => {
    expect(
      withEnv(PROD_BASE, {
        BOOKING_ORCHESTRATOR_ENABLED: 'true',
        BOOKING_ORCHESTRATOR_MODE: 'active',
        INVENTORY_SOURCING_ENABLED: 'true',
        PAYMENT_PROVIDER_NAME: 'stripe',
        DOMAIN_EVENT_DELIVERY_MODE: 'outbox',
      }),
    ).toThrow(/DISPATCH/i);
  });

  it('allows a fully-safe active production configuration', () => {
    expect(
      withEnv(PROD_BASE, {
        BOOKING_ORCHESTRATOR_ENABLED: 'true',
        BOOKING_ORCHESTRATOR_MODE: 'active',
        INVENTORY_SOURCING_ENABLED: 'true',
        PAYMENT_PROVIDER_NAME: 'stripe',
      }),
    ).not.toThrow();
  });
});
