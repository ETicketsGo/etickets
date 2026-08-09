import { AxiosError } from 'axios';

/**
 * Whether the server never answered, as opposed to answering with a refusal.
 *
 * The difference decides whether a session is destroyed. "401, your token is dead" and
 * "aeroplane mode" both surface as a thrown error, and treating them alike is what made
 * the app delete a perfectly good refresh token every time it launched without signal —
 * which is precisely when its cached tickets were needed. Only the server may end a
 * session; the network may not.
 *
 * ── WHY ITS OWN FILE ──────────────────────────────────────────────────────────────
 * This is a leaf: it imports axios and nothing else in the app. It lived in errors.ts
 * first, which imports http.ts, which imports api-client.ts — so api-client importing it
 * from there closed a cycle (api-client → errors → http → api-client). That particular
 * cycle happened to be harmless, because the predicate is only called at request time and
 * every module has finished evaluating by then. It is not worth relying on that: the
 * failure mode of a module cycle is an undefined binding at import time, which shows up as
 * a crash on the first request rather than as anything a typechecker or a test would flag.
 * A dependency-free module cannot participate in a cycle at all.
 */
export function isUnreachable(error: unknown): boolean {
  return error instanceof AxiosError && !error.response;
}
