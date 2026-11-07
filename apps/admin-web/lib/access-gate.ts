import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/*
  The origin half of the identity-aware access gate in front of admin.eticketsgo.com
  (docs/security/ADMIN-ACCESS-GATE.md, AR-34 / AR-42).

  Cloudflare Access sits in front of the host and signs every request it lets through with a
  short-lived JWT in the `Cf-Access-Jwt-Assertion` header. Cloudflare can only protect traffic
  that goes through it: anyone who sends a request straight to Railway (the generated
  `*.up.railway.app` name, or the Railway edge with the right Host header) skips Access. So the
  app itself refuses any request that does not carry a valid Access token for THIS application.

  This is IN ADDITION to the console's own sign-in, MFA and role checks, which are unchanged:
  passing Access only lets a person reach the sign-in page.

  ADMIN_ACCESS_GATE
    off      (default, also when unset or unknown) - no check at all: today's behaviour.
    report   - check and log what would be refused, refuse nothing. Run this first after Access
               is switched on at Cloudflare, to prove every real request carries a valid token.
    enforce  - refuse every request without a valid token (403), except the health probe.
  CF_ACCESS_TEAM_DOMAIN  `<team>.cloudflareaccess.com` (the Zero Trust team domain)
  CF_ACCESS_AUD          the Access application's "Application Audience (AUD) Tag"
  Neither value is a secret: the AUD tag only names the application, and the signing keys are
  fetched from Cloudflare's public certs endpoint.
*/

export type GateMode = 'off' | 'report' | 'enforce';

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/** Unknown or empty values fall back to `off`, so a typo can never lock administrators out. */
export function parseGateMode(raw: string | undefined): GateMode {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'report' || v === 'enforce' ? v : 'off';
}

/*
  Paths answered without a token. Only the liveness probe: Railway calls it directly on the
  container (never through Cloudflare), and a deployment would never go healthy otherwise. It
  returns a fixed `{status:'ok'}` and reads nothing.
*/
const EXEMPT_PATHS = new Set(['/api/health']);

export function isExemptPath(pathname: string): boolean {
  return EXEMPT_PATHS.has(pathname);
}

/** Only a Cloudflare Zero Trust team domain: the keys are fetched from it, so no other host. */
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

export interface GateConfig {
  mode: GateMode;
  teamDomain: string;
  audience: string;
  /** Why the config cannot verify anything, or null when it can. */
  problem: string | null;
}

export function readGateConfig(env: Record<string, string | undefined>): GateConfig {
  const mode = parseGateMode(env.ADMIN_ACCESS_GATE);
  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '');
  const audience = (env.CF_ACCESS_AUD ?? '').trim();
  let problem: string | null = null;
  if (!TEAM_DOMAIN.test(teamDomain))
    problem = 'CF_ACCESS_TEAM_DOMAIN is not a <team>.cloudflareaccess.com name';
  else if (!/^[0-9a-f]{64}$/i.test(audience))
    problem = 'CF_ACCESS_AUD is not a 64-character AUD tag';
  return { mode, teamDomain, audience, problem };
}

const keySets = new Map<string, JWTVerifyGetKey>();

/** Cloudflare's public signing keys for the team, cached and refreshed by jose. */
export function cloudflareKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = keySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`), {
      timeoutDuration: 5000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    keySets.set(teamDomain, keys);
  }
  return keys;
}

export type GateVerdict =
  | { allow: true; reason: 'off' | 'exempt' | 'valid' }
  | { allow: false; reason: 'no-token' | 'invalid-token' | 'misconfigured'; detail?: string };

/**
 * Whether one request may reach the app. Pure apart from the key lookup, which is injected so
 * tests can sign their own tokens.
 */
export async function checkRequest(
  config: GateConfig,
  pathname: string,
  token: string | null,
  getKey: JWTVerifyGetKey,
): Promise<GateVerdict> {
  if (config.mode === 'off') return { allow: true, reason: 'off' };
  if (isExemptPath(pathname)) return { allow: true, reason: 'exempt' };
  if (config.problem) return { allow: false, reason: 'misconfigured', detail: config.problem };
  if (!token) return { allow: false, reason: 'no-token' };
  try {
    await jwtVerify(token, getKey, {
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat'],
      clockTolerance: 30,
    });
    return { allow: true, reason: 'valid' };
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'ERR_UNKNOWN';
    return { allow: false, reason: 'invalid-token', detail: code };
  }
}
