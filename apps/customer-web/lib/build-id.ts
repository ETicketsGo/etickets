/**
 * Which build is this browser on?
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────────────
 * "Is the fix live?" and "which build did the tester see?" had no answer from the browser: the
 * only way to learn what a deployment ran was the hosting dashboard. The short commit is now in
 * a meta tag (`<meta name="build-id">`) and in the footer, and `/api/health` reports it too.
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
