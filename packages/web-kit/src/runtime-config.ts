/**
 * Public configuration read when the app RUNS, not when it is built (AR-17, web half).
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────
 * Next inlines every literal `process.env.NEXT_PUBLIC_X` into the bundle at build time, so a
 * web image built for QA carries QA's API address and cannot be promoted to UAT or production
 * unchanged. Here the same variables are read at request time instead, and served to the
 * browser by each app's `/runtime-config.js` route, which loads before the app's own scripts.
 *
 * ── NO NEW VARIABLES ───────────────────────────────────────────────────────────────────
 * The server reads the variables the services already have (`NEXT_PUBLIC_API_URL`, ...), by a
 * COMPUTED name: Next only inlines the literal member expression, so `process.env[name]` is
 * the real runtime environment of the container. Today's build-time value stays the fallback,
 * so a build made the old way behaves exactly as before, with or without the route.
 *
 * ── WHAT MAY BE SERVED ─────────────────────────────────────────────────────────────────
 * Only the keys below, all of which are public by definition: they are in every bundle today.
 * URL keys must be absolute http(s) URLs and APP_ENV a plain word; anything else is dropped,
 * so a mistyped variable falls back to the build-time value instead of breaking the page.
 */

export const RUNTIME_CONFIG_KEYS = [
  'API_URL',
  'APP_ENV',
  'SITE_URL',
  'ORGANIZER_URL',
  'ADMIN_URL',
  'STOREFRONT_URL',
  'APP_RETURN_SCHEME',
] as const;

export type RuntimeConfigKey = (typeof RUNTIME_CONFIG_KEYS)[number];
export type RuntimeConfig = Partial<Record<RuntimeConfigKey, string>>;

/** The global the `/runtime-config.js` script sets. */
export const RUNTIME_CONFIG_GLOBAL = '__ETG_RUNTIME_CONFIG__';

const URL_KEYS: ReadonlySet<RuntimeConfigKey> = new Set([
  'API_URL',
  'SITE_URL',
  'ORGANIZER_URL',
  'ADMIN_URL',
  'STOREFRONT_URL',
]);

/** A value as it may be served for `key`, or undefined when it does not look right. */
export function cleanRuntimeValue(key: RuntimeConfigKey, raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  if (!v || v.length > 512) return undefined;
  if (URL_KEYS.has(key)) {
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
      if (u.username || u.password) return undefined;
      return v.replace(/\/+$/, '');
    } catch {
      return undefined;
    }
  }
  if (key === 'APP_ENV') return /^[A-Za-z_]{1,32}$/.test(v) ? v : undefined;
  if (key === 'APP_RETURN_SCHEME') return /^[a-z][a-z0-9+.-]{0,40}$/.test(v) ? v : undefined;
  return undefined;
}

type Env = Record<string, string | undefined>;

function serverEnv(): Env {
  // `globalThis.process` rather than `process`, so no bundler polyfills or inlines anything.
  const p = (globalThis as { process?: { env?: Env } }).process;
  return p?.env ?? {};
}

/**
 * Server side, at request time: the public configuration of THIS container. Reads
 * `ETG_PUBLIC_<KEY>` first (an explicit runtime override), then `NEXT_PUBLIC_<KEY>`.
 */
export function readServerRuntimeConfig(env: Env = serverEnv()): RuntimeConfig {
  const out: RuntimeConfig = {};
  for (const key of RUNTIME_CONFIG_KEYS) {
    const value =
      cleanRuntimeValue(key, env[`ETG_PUBLIC_${key}`]) ??
      cleanRuntimeValue(key, env[['NEXT', 'PUBLIC', key].join('_')]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// Valid in JSON, but end a line in a script: escape them too.
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

/** The body of `/runtime-config.js`: one assignment, JSON escaped for a script context. */
export function runtimeConfigScript(config: RuntimeConfig): string {
  const json = JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');
  return `window.${RUNTIME_CONFIG_GLOBAL}=Object.freeze(${json});\n`;
}

/** Headers for the script: never cached by a shared cache, so a variable change shows at once. */
export const RUNTIME_CONFIG_HEADERS: Record<string, string> = {
  'content-type': 'application/javascript; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/**
 * The value to use for `key`: the runtime value when there is one (browser: the served script;
 * server: this container's environment), else `buildTime` - the literal
 * `process.env.NEXT_PUBLIC_<KEY>` the caller passes, which Next inlined at build time.
 */
export function runtimeValue(
  key: RuntimeConfigKey,
  buildTime: string | undefined,
): string | undefined {
  if (typeof window !== 'undefined') {
    const served = (window as unknown as Record<string, RuntimeConfig | undefined>)[
      RUNTIME_CONFIG_GLOBAL
    ];
    return cleanRuntimeValue(key, served?.[key]) ?? buildTime;
  }
  return readServerRuntimeConfig()[key] ?? buildTime;
}
