// Run with: node --test scripts/certification/razorpay-payment-certification.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCertification, READ_PATHS } from './razorpay-payment-certification.mjs';

const pass = (key) => ({ key, label: key, passed: true });

function healthy() {
  return {
    readiness: {
      env: 'PRODUCTION',
      global: ['live-enabled', 'secret-manager', 'maintenance-off'].map(pass),
      providers: [
        {
          provider: 'razorpay',
          checks: [
            'mode-live',
            'credentials',
            'health',
            'webhook-delivered',
            'route',
            'circuit',
          ].map(pass),
        },
      ],
    },
    launchGate: {
      reconciliation: { openDiscrepancies: 0 },
      providers: [{ provider: 'razorpay', goNoGo: 'GO', failedChecks: [] }],
    },
    reconciliation: { checked: 3, matched: 3, mismatched: 0, unverifiable: 0 },
    unresolved: { unresolvedTransfers: [], openFindings: [], blockedSettlements: [] },
  };
}

const failing = (v) => v.checks.filter((c) => !c.passed && !c.advisory).map((c) => c.id);

describe('evaluateCertification', () => {
  it('certifies a fully healthy production snapshot', () => {
    const v = evaluateCertification(healthy());
    assert.equal(v.passed, true, JSON.stringify(failing(v)));
  });

  it('fails when the webhook secret has never been proven', () => {
    const s = healthy();
    s.readiness.providers[0].checks.find((c) => c.key === 'webhook-delivered').passed = false;
    assert.deepEqual(failing(evaluateCertification(s)), ['webhook-delivered']);
  });

  it('treats an unreadable response as a failure, never a skip', () => {
    for (const key of ['readiness', 'launchGate', 'reconciliation', 'unresolved']) {
      const s = healthy();
      s[key] = null;
      assert.equal(evaluateCertification(s).passed, false, key);
    }
  });

  it('does not accept a clean reconciliation that checked nothing, or one it could not verify', () => {
    const empty = healthy();
    empty.reconciliation = { checked: 0, matched: 0, mismatched: 0, unverifiable: 0 };
    assert.deepEqual(failing(evaluateCertification(empty)), ['reconcile-ran']);
    const blind = healthy();
    blind.reconciliation = { checked: 4, matched: 0, mismatched: 0, unverifiable: 4 };
    assert.deepEqual(failing(evaluateCertification(blind)), ['reconcile-clean']);
  });

  it('fails any unresolved money or open discrepancy', () => {
    const s = healthy();
    s.unresolved.openFindings = [{ id: 'f1' }];
    s.launchGate.reconciliation.openDiscrepancies = 2;
    assert.deepEqual(failing(evaluateCertification(s)).sort(), [
      'no-open-discrepancies',
      'no-unresolved-money',
    ]);
  });

  it('refuses a non-production environment unless told it is only a rehearsal', () => {
    const s = healthy();
    s.readiness.env = 'QA';
    assert.deepEqual(failing(evaluateCertification(s)), ['env-production']);
    assert.equal(evaluateCertification(s, { requireProduction: false }).passed, true);
  });

  it('reads only endpoints under /admin/payments', () => {
    for (const p of Object.values(READ_PATHS)) assert.match(p, /^\/admin\/payments\//);
  });
});

describe('advisory checks', () => {
  it('reports the bookkeeping records and certification without letting them decide', () => {
    // The healthy fixture carries none of merchant-active, webhook-verified or certification.
    const v = evaluateCertification(healthy());
    const advisory = v.checks.filter((c) => c.advisory);
    assert.deepEqual(advisory.map((c) => c.id).sort(), [
      'certification',
      'merchant-active',
      'webhook-verified',
    ]);
    assert.ok(advisory.every((c) => !c.passed));
    assert.equal(v.passed, true);
  });
});
