import type { ConfigService } from '@nestjs/config';

/**
 * Whether this process may write what a message SAYS into its log.
 *
 * ── WHY THIS IS A SINGLE RULE ──────────────────────────────────────────────────────
 * The `log` transports exist so a developer can see a message without a provider account --
 * including the six digits of a sign-in code. They printed the body unconditionally, and QA and
 * UAT run them: every phone sign-in code requested there was written to a log that Railway
 * retains and anybody with project access can read. That is a live credential in a log, which
 * is exactly what the sign-in service promised would never happen outside local development.
 *
 * One function, read by every transport and by the sign-in service, so the answer to "may a
 * body be logged here" cannot differ between the place that sends a code and the place that
 * prints it.
 *
 * ── WHY IT FAILS CLOSED ────────────────────────────────────────────────────────────
 * LOCAL or DEV only, and never under NODE_ENV=production -- QA, UAT and production all build
 * production bundles, so a deployed environment that forgot APP_ENV still withholds. No
 * configuration at all withholds too: a transport constructed without one has no way of
 * knowing where it is running.
 */
export function messageContentLoggable(config: Pick<ConfigService, 'get'> | undefined): boolean {
  if (!config) return false;
  const appEnv = config.get<string>('APP_ENV') ?? 'LOCAL';
  const nodeEnv = config.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
  return (appEnv === 'LOCAL' || appEnv === 'DEV') && nodeEnv !== 'production';
}
