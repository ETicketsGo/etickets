import { ConsoleLogger, type LoggerService } from '@nestjs/common';

/**
 * Nest's own logger with the boot-time route inventory removed.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────────────
 * Nest logs one line per mapped route at startup, and this API maps well over a thousand.
 * Railway drops everything past 500 logs/sec per replica, so the flood arrives at exactly the
 * moment a failing boot would be explaining itself - and the explanation is what gets dropped.
 *
 * That is not hypothetical. A production deploy failed with **803 messages dropped**, and the
 * cause - `Provider 'razorpay' is enabled in PRODUCTION but still in TEST mode` - survived only
 * because the log store could afterwards be queried by severity. Reading the tail showed nothing
 * but route mappings and the rate-limit notice. An API that drowns its own failure report is one
 * nobody can operate, which is the same lesson as the exception filter and the worker's boot.
 *
 * ── WHY BY CONTEXT AND NOT BY LEVEL ────────────────────────────────────────────────
 * Nest writes those lines at `log` level, the same level as "API listening" and as the boot
 * guards' own findings. Narrowing to `['error','warn']` would have hidden the very lines an
 * operator reads on a healthy start, so the two noisy CONTEXTS are dropped instead and every
 * other message is untouched.
 *
 * Kept in LOCAL and DEV, where the route list is genuinely useful and no rate limit applies.
 * Keyed on APP_ENV, never NODE_ENV: QA and UAT both run NODE_ENV=production.
 */
const BOOT_INVENTORY_CONTEXTS = new Set(['RoutesResolver', 'RouterExplorer', 'InstanceLoader']);

export class QuietBootLogger extends ConsoleLogger {
  override log(message: unknown, ...rest: unknown[]): void {
    // Nest passes the context as the last argument on these calls.
    const context =
      typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : undefined;
    if (context && BOOT_INVENTORY_CONTEXTS.has(context)) return;
    super.log(message as string, ...(rest as string[]));
  }
}

/** The logger to boot with, or `undefined` to keep Nest's default. */
export function quietBootLogger(
  appEnv: string | undefined = process.env.APP_ENV,
): LoggerService | undefined {
  const env = (appEnv ?? 'LOCAL').trim().toUpperCase();
  if (env === 'LOCAL' || env === 'DEV') return undefined;
  return new QuietBootLogger();
}
