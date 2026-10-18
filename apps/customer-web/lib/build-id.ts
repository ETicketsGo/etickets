/**
 * Which build is this browser on?
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────────────
 * "Is the fix live?" and "which build did the tester see?" had no answer from the browser: the
 * only way to learn what a deployment ran was the hosting dashboard. The short commit is now in
 * a meta tag (`<meta name="build-id">`) and `/api/health` on every environment, and in the
 * footer on test environments only (see `isTestEnvironment` below).
 *
 * ── WHERE IT COMES FROM ────────────────────────────────────────────────────────────
 * The platform's own commit variable, read when the server handles a request - not baked into
 * the bundle at build time. That way it cannot disagree with the process that is answering, and
 * no Docker build argument has to be declared for it to arrive. It is a commit hash: public
 * information on a public repository, never a secret, and the first seven characters are all
 * that is shown.
 */

const SOURCES = [
  'BUILD_SHA',
  'RAILWAY_GIT_COMMIT_SHA',
  'SOURCE_COMMIT',
  'GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_SHA',
] as const;

/** The short commit from an environment, or null when the platform did not provide one. */
export function buildIdFrom(env: Record<string, string | undefined>): string | null {
  for (const name of SOURCES) {
    const value = env[name]?.trim();
    // Only a hex string is a commit; anything else (a branch name, a placeholder) is not shown.
    if (value && /^[0-9a-f]{7,40}$/i.test(value)) return value.slice(0, 7).toLowerCase();
  }
  return null;
}

/** The short commit of the running server, or null in local development. */
export function buildId(): string | null {
  return buildIdFrom(process.env);
}

/**
 * Is this a test environment (QA, UAT, a staging copy) rather than the real shop?
 *
 * ── WHY THE FOOTER ASKS ────────────────────────────────────────────────────────────
 * The visible "Build abc1234" line is for testers: the QA walks read it to know which commit
 * they are looking at. On the live shop it is noise a customer cannot use (the owner asked
 * "why we are seeing build on PROD"), so the footer shows it only where this is true. The
 * `<meta name="build-id">` tag and `/api/health` keep the commit on every environment,
 * production included, so a deployment can still be verified there - just not by reading
 * the page.
 *
 * ── THE SIGNAL ─────────────────────────────────────────────────────────────────────
 * `NEXT_PUBLIC_APP_ENV`, the same signal as the "Test environment - payments are simulated"
 * notice, so the two can never disagree about where they are. It is a build argument: QA and
 * UAT pass their name, production passes nothing. Unset therefore means production, and
 * an explicit PRODUCTION means the same. The caller passes the literal
 * `process.env.NEXT_PUBLIC_APP_ENV` so Next inlines it into the client bundle.
 */
export function isTestEnvironment(appEnv: string | undefined): boolean {
  const name = (appEnv ?? '').trim().toUpperCase();
  return name !== '' && name !== 'PRODUCTION';
}
