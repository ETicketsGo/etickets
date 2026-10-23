/**
 * Settings for the human check (Cloudflare Turnstile), read once at boot.
 *
 * ── WHY IT IS OFF UNTIL SOMEBODY TURNS IT ON ───────────────────────────────────────
 * A challenge in front of sign-in is a change every customer can feel, and a wrong key or a
 * hostname missing from the widget turns it into "nobody can sign in". So unset means `off`:
 * the guard does nothing, no request leaves for Cloudflare, and the storefront never draws a
 * widget. The owner switches an environment on by setting keys and a mode, QA first.
 *
 * ── THE THREE MODES ────────────────────────────────────────────────────────────────
 *   off       the guard is a pass-through.
 *   adaptive  a token is asked for only when the caller looks risky (see `HumanCheckRisk`):
 *             the first few attempts from an address in a window go through untouched.
 *   always    every request to a decorated route must carry a token.
 *
 * ── WHAT EACH ROUTE DOES WHEN CLOUDFLARE CANNOT ANSWER ─────────────────────────────
 * "Cannot answer" means a timeout, a network error, a 5xx, a body that is not the documented
 * JSON, or an answer saying OUR secret is wrong. It never means "the visitor failed": a failed
 * challenge is always a refusal. See `HUMAN_CHECK_ACTIONS` for the per-route choice and the
 * reason for it. `TURNSTILE_FAIL_OPEN` overrides it everywhere when set, for an incident.
 */

/** A route class. The same name is the Turnstile `action`, so it must stay [a-z_], <= 32. */
export type HumanCheckAction =
  | 'login'
  | 'register'
  | 'otp'
  | 'password_reset'
  | 'guest_checkout'
  | 'guest_lookup'
  | 'support'
  | 'organization';

export type HumanCheckMode = 'off' | 'adaptive' | 'always';

interface ActionPolicy {
  /** Which adaptive threshold applies: `strict` for cheap-to-abuse sends, `lenient` otherwise. */
  tier: 'strict' | 'lenient';
  /** Let the request through when Cloudflare cannot answer (unless TURNSTILE_FAIL_OPEN says). */
  failOpen: boolean;
}

/*
  The per-route choices.

  FAIL OPEN where refusing would stop a customer doing the thing they came to do and the route
  has its own defence behind it: sign-in (the password is the real check, and the per-route
  throttle still counts), guest checkout (a booking still has to be paid for, and refusing it
  during somebody else's outage loses a sale), the guest lookup and password reset (each sends
  at most one email to an address the caller already named, and both answer the same either
  way), the support form, and organizer sign-up (an account is needed first, so a bot is already
  past the register check).

  FAIL CLOSED for the two routes whose whole cost is in being called at volume:
    - `otp` sends a text message. SMS pumping (sending codes to premium-rate numbers) is paid
      per message, by us, and the throttle limits a single address, not a botnet. An attacker
      who can wait for a Cloudflare incident should not get free messages for its length.
    - `register` creates an account. Accounts made during an outage stay made.
  In adaptive mode this only affects a caller who was already asked to prove itself, so the
  ordinary customer never sees it. In always mode it means "phone codes and new accounts pause
  while Cloudflare is down" - which is the trade the owner makes by choosing always.
*/
export const HUMAN_CHECK_ACTIONS: Record<HumanCheckAction, ActionPolicy> = {
  login: { tier: 'lenient', failOpen: true },
  register: { tier: 'strict', failOpen: false },
  otp: { tier: 'strict', failOpen: false },
  password_reset: { tier: 'strict', failOpen: true },
  guest_checkout: { tier: 'lenient', failOpen: true },
  guest_lookup: { tier: 'strict', failOpen: true },
  support: { tier: 'strict', failOpen: true },
  organization: { tier: 'strict', failOpen: true },
};

export interface HumanCheckSettings {
  mode: HumanCheckMode;
  siteKey: string | null;
  secretKey: string | null;
  /** Lower-cased. Empty means "do not check the hostname" (refused at boot when deployed). */
  allowedHostnames: string[];
  /** `null` = use each route's own choice above. */
  failOpenOverride: boolean | null;
  verifyTimeoutMs: number;
  maxTokenAgeSeconds: number;
  adaptiveWindowSeconds: number;
  adaptiveStrictLimit: number;
  adaptiveLenientLimit: number;
}

interface ConfigLike {
  get<T>(key: string): T | undefined;
}

/** Whole numbers inside a range, or the default. Values arrive parsed at boot and raw in tests. */
function bounded(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim() || NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function text(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v ? v : null;
}

export function humanCheckSettings(config: ConfigLike): HumanCheckSettings {
  const rawMode = (text(config.get<string>('TURNSTILE_MODE')) ?? 'off').toLowerCase();
  // Anything unrecognised reads as off: a typo must never be the thing that blocks sign-in.
  const mode: HumanCheckMode =
    rawMode === 'adaptive' || rawMode === 'always' ? (rawMode as HumanCheckMode) : 'off';
  const failOpenRaw = (text(config.get<string>('TURNSTILE_FAIL_OPEN')) ?? '').toLowerCase();
  return {
    mode,
    siteKey: text(config.get<string>('TURNSTILE_SITE_KEY')),
    secretKey: text(config.get<string>('TURNSTILE_SECRET_KEY')),
    allowedHostnames: (config.get<string>('TURNSTILE_ALLOWED_HOSTNAMES') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    failOpenOverride: failOpenRaw === 'true' ? true : failOpenRaw === 'false' ? false : null,
    verifyTimeoutMs: bounded(config.get('TURNSTILE_VERIFY_TIMEOUT_MS'), 3000, 500, 10_000),
    // Cloudflare itself expires a token after 300 seconds, so a longer limit would mean nothing.
    maxTokenAgeSeconds: bounded(config.get('TURNSTILE_MAX_TOKEN_AGE_SECONDS'), 300, 30, 300),
    adaptiveWindowSeconds: bounded(
      config.get('TURNSTILE_ADAPTIVE_WINDOW_SECONDS'),
      600,
      60,
      86_400,
    ),
    adaptiveStrictLimit: bounded(config.get('TURNSTILE_ADAPTIVE_STRICT_LIMIT'), 3, 0, 1000),
    adaptiveLenientLimit: bounded(config.get('TURNSTILE_ADAPTIVE_LENIENT_LIMIT'), 5, 0, 1000),
  };
}

/** Environments with no public hostname of their own: a laptop, or a test run. */
const DEVELOPER_ENVIRONMENTS = ['LOCAL', 'DEV', 'TEST'];

/**
 * Cloudflare's published dummy keys start `1x0000`, `2x0000` or `3x0000` (always passes, always
 * fails, always "already spent"). Useful on QA; a production widget built on one protects nothing.
 */
const CLOUDFLARE_TEST_KEY = /^[123]x0{4}/;

/**
 * Refuse to boot with a human check that is switched on but cannot work.
 *
 * Checked here rather than in `config/configuration.ts` so that file only gains its variables;
 * `HumanCheckService` calls it in its constructor, which runs at boot, the way `RedisService`
 * refuses to construct without a usable URL.
 */
export function assertHumanCheckSettings(settings: HumanCheckSettings, appEnv?: string): void {
  if (settings.mode === 'off') return;
  const env = (appEnv ?? 'LOCAL').trim().toUpperCase() || 'LOCAL';
  const errors: string[] = [];
  if (!settings.secretKey) errors.push('  - TURNSTILE_SECRET_KEY is not set.');
  if (!settings.siteKey) errors.push('  - TURNSTILE_SITE_KEY is not set.');
  if (!DEVELOPER_ENVIRONMENTS.includes(env) && settings.allowedHostnames.length === 0) {
    errors.push(
      '  - TURNSTILE_ALLOWED_HOSTNAMES is not set: a token solved on any site would be accepted.',
    );
  }
  if (
    env === 'PRODUCTION' &&
    [settings.secretKey, settings.siteKey].some((k) => k && CLOUDFLARE_TEST_KEY.test(k))
  ) {
    errors.push(
      '  - A Cloudflare TEST key is set in APP_ENV=PRODUCTION. Use the real widget keys.',
    );
  }
  if (errors.length > 0) {
    throw new Error(
      `TURNSTILE_MODE=${settings.mode} cannot work as configured:\n${errors.join('\n')}\n` +
        'Set the missing values, or set TURNSTILE_MODE=off.',
    );
  }
}
