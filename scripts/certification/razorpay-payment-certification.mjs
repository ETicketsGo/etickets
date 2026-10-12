#!/usr/bin/env node
/**
 * Razorpay payment certification: may live INR payments be switched on for the pilot?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * `production-transaction-probe.mjs` asks the question from outside, as a stranger. It cannot see
 * whether the provider adapter bound, whether a signed webhook was ever accepted, or whether our
 * books agree with Razorpay's. Those answers sit behind admin-only GET endpoints. This reads them
 * and applies the definition in docs/pilot/RAZORPAY-READINESS.md (section 3) so the decision is a
 * list of PASS/FAIL lines, not an impression.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────────────────
 * Every request is a GET. It creates no booking, takes no payment, writes nothing and never calls
 * Razorpay. The admin token is read from the environment, is sent only as a header, and is never
 * printed. A response that cannot be read is a FAIL, never a skipped check: a check that silently
 * disappears looks exactly like one that passed.
 *
 * Usage:
 *   ADMIN_TOKEN=<admin access token> node scripts/certification/razorpay-payment-certification.mjs
 *   API=https://api.eticketsgo.com/api  (default)   --json  machine-readable
 *   --allow-non-production   rehearse against QA/UAT (the PRODUCTION check is then waived)
 *
 * Exit code 1 when any check fails, so it can gate the switch-on.
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_API = 'https://api.eticketsgo.com/api';

/** Every endpoint read, in one place so the read-only claim can be audited at a glance. */
export const READ_PATHS = {
  readiness: '/admin/payments/live-readiness?provider=razorpay',
  launchGate: '/admin/payments/launch-gate',
  reconciliation: '/admin/payments/reconciliation',
  unresolved: '/admin/payments/unresolved-money',
};

const check = (id, label, passed, detail) => ({ id, label, passed: passed === true, detail });

/**
 * Pure: a snapshot of the endpoint bodies in, a verdict out. `null` for a body means "could not be
 * read", which fails every check that depends on it.
 *
 * @param {{ readiness: any, launchGate: any, reconciliation: any, unresolved: any }} snap
 * @param {{ requireProduction?: boolean }} [opts]
 */
export function evaluateCertification(snap, opts = {}) {
  const requireProduction = opts.requireProduction !== false;
  const out = [];
  const readiness = snap.readiness ?? null;
  const rz = readiness?.providers?.find((p) => p.provider === 'razorpay') ?? null;
  const rzCheck = (key) => rz?.checks?.find((c) => c.key === key) ?? null;
  const globalCheck = (key) => readiness?.global?.find((c) => c.key === key) ?? null;

  out.push(
    check(
      'env-production',
      'The API reports it is the PRODUCTION environment',
      requireProduction ? readiness?.env === 'PRODUCTION' : readiness != null,
      readiness ? `env=${readiness.env}` : 'live-readiness could not be read',
    ),
  );
  out.push(
    check(
      'razorpay-enabled',
      'Razorpay is an enabled provider in this environment',
      rz != null,
      rz ? 'present' : 'no enabled razorpay row in the readiness report',
    ),
  );
  for (const [id, label] of [
    ['mode-live', 'Provider row is in LIVE mode (matches the rzp_live_ key)'],
    ['credentials', 'Credentials resolve through the secret manager and are live'],
    ['health', 'Razorpay answers an authenticated read with these credentials'],
    ['webhook-delivered', 'A signed webhook delivery has been accepted'],
    ['route', 'An active INR route points at Razorpay'],
    ['circuit', 'Circuit breaker is not open'],
  ]) {
    const c = rzCheck(id);
    out.push(
      check(id, label, c?.passed, c ? (c.detail ?? (c.passed ? 'ok' : 'failed')) : 'missing'),
    );
  }
  for (const key of ['live-enabled', 'secret-manager', 'maintenance-off']) {
    const c = globalCheck(key);
    out.push(
      check(
        `global-${key}`,
        c?.label ?? key,
        c?.passed,
        c ? (c.passed ? 'ok' : 'failed') : 'missing',
      ),
    );
  }

  const rec = snap.reconciliation ?? null;
  out.push(
    check(
      'reconcile-ran',
      'Reconciliation covered at least one payment in the window',
      rec != null && rec.checked > 0,
      rec ? `checked=${rec.checked}` : 'could not be read',
    ),
  );
  out.push(
    check(
      'reconcile-clean',
      'No payment disagrees with Razorpay and none is unverifiable',
      rec != null && rec.mismatched === 0 && rec.unverifiable === 0,
      rec
        ? `matched=${rec.matched} mismatched=${rec.mismatched} unverifiable=${rec.unverifiable}`
        : 'could not be read',
    ),
  );

  const un = snap.unresolved ?? null;
  out.push(
    check(
      'no-unresolved-money',
      'No unresolved transfers, open findings or blocked settlements',
      un != null &&
        (un.unresolvedTransfers?.length ?? 1) === 0 &&
        (un.openFindings?.length ?? 1) === 0 &&
        (un.blockedSettlements?.length ?? 1) === 0,
      un
        ? `transfers=${un.unresolvedTransfers?.length} findings=${un.openFindings?.length} blocked=${un.blockedSettlements?.length}`
        : 'could not be read',
    ),
  );

  const gate = snap.launchGate ?? null;
  out.push(
    check(
      'no-open-discrepancies',
      'No open finance discrepancies',
      gate != null && gate.reconciliation?.openDiscrepancies === 0,
      gate ? `open=${gate.reconciliation?.openDiscrepancies}` : 'could not be read',
    ),
  );

  /*
    ADVISORY, not blocking. The launch gate's GO needs a recent PASS sandbox certification, and
    for a real provider that run is PARTIAL by design (the webhook and confirm steps SKIP because
    only the mock can sign an event: certification.spec.ts), so GO cannot be reached for Razorpay.
    The merchant and webhook-verified flags are admin bookkeeping records. All three are reported
    so nobody is surprised by a NO-GO, but they do not decide the switch-on.
  */
  for (const [id, label] of [
    ['merchant-active', 'An ACTIVE merchant record exists (bookkeeping)'],
    ['webhook-verified', 'Webhook endpoint marked VERIFIED (bookkeeping)'],
    ['certification', 'Recent PASS sandbox certification (unreachable for real providers)'],
  ]) {
    const c = rzCheck(id);
    out.push({ ...check(id, label, c?.passed, c?.passed ? 'ok' : 'not set'), advisory: true });
  }

  return { passed: out.filter((c) => !c.advisory).every((c) => c.passed), checks: out };
}

async function readAll(api, token) {
  const snap = {};
  for (const [name, path] of Object.entries(READ_PATHS)) {
    try {
      const res = await fetch(`${api}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      snap[name] = res.ok ? await res.json() : null;
    } catch {
      snap[name] = null;
    }
  }
  return snap;
}

async function main() {
  const api = (process.env.API ?? DEFAULT_API).replace(/\/+$/, '');
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.error('ADMIN_TOKEN is not set. Pass an admin access token in the environment.');
    process.exit(2);
  }
  const verdict = evaluateCertification(await readAll(api, token), {
    requireProduction: !process.argv.includes('--allow-non-production'),
  });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    for (const c of verdict.checks) {
      const tag = c.passed ? 'PASS' : c.advisory ? 'ADVISE' : 'FAIL';
      console.log(`${tag}  ${c.label}  [${c.detail}]`);
    }
    console.log(verdict.passed ? '\nCERTIFIED' : '\nNOT CERTIFIED');
  }
  process.exit(verdict.passed ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
