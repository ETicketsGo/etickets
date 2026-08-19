import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Which Razorpay webhook route the documentation tells an operator to register.
 *
 * ── WHY THIS IS A TEST ────────────────────────────────────────────────────────────
 * There are two Razorpay routes, one character apart, and they behave differently:
 *
 *   POST /api/payments/webhooks/razorpay   durable + idempotent; unhandled events are
 *                                          persisted and marked IGNORED
 *   POST /api/payments/webhook/razorpay    the generic multi-provider router, whose
 *                                          Razorpay adapter accepts ONLY payment.captured
 *                                          and payment.failed and 4xxs everything else
 *
 * Two deployment documents and three environment templates named the singular one, with the
 * full event list. An operator following them would have had Razorpay retry `order.paid`,
 * `refund.processed` and the dispute events until it disabled the endpoint — and refunds
 * would never have reconciled. Nothing failed; the configuration was simply wrong, in the
 * documents used to set up an environment.
 *
 * A typo in prose cannot be caught by a unit test of the handler, so it is caught here.
 */
const REPO = resolve(__dirname, '../../../../..');
const SEARCH_ROOTS = ['docs', 'deploy'];

/** The generic route, spelled so this file's own prose cannot match it. */
const SINGULAR = ['/api/payments/', 'webhook', '/razorpay'].join('');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(md|example|ya?ml|json)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('Razorpay webhook route in operator-facing files', () => {
  const files = SEARCH_ROOTS.flatMap((root) => {
    try {
      return walk(join(REPO, root));
    } catch {
      return [];
    }
  });

  it('finds the documentation to check', () => {
    // Guards the guard: a wrong REPO path would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(20);
  });

  it('never tells an operator to register the generic single-provider route', () => {
    const offenders = files
      .filter((f) => !f.endsWith('razorpay-webhook-route.spec.ts'))
      .flatMap((file) => {
        const lines = readFileSync(file, 'utf8').split('\n');
        return lines
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => line.includes(SINGULAR) && !line.includes(`${SINGULAR}s`))
          .map(({ n, line }) => `${file.slice(REPO.length + 1)}:${n}  ${line.trim()}`);
      });

    // Listed in full so a failure names every file rather than only the first.
    expect(offenders).toEqual([]);
  });
});
