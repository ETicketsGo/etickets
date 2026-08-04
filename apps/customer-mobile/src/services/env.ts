import Constants from 'expo-constants';
import { isLocalApiUrl } from '@eticketsgo/shared-types';

/** Typed, validated access to the app's public runtime config (from app.config.ts `extra`). */
interface Env {
  apiUrl: string;
  webHost: string | null;
  sentryDsn: string | null;
  env: 'development' | 'staging' | 'production';
}

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

/**
 * Read a value from `extra` only if it is actually a non-empty string.
 *
 * This is not paranoia about types. `app.config.ts` writes
 * `webHost: process.env.EXPO_PUBLIC_WEB_HOST ?? null`, and Expo's config
 * serialisation turns that `null` into `{}` — an EMPTY OBJECT, which is truthy. A plain
 * `extra.webHost ?? null` therefore yields `{}` rather than null, and the first thing
 * that happens to it is `webHost.toLowerCase()` in the deep-link host check, which
 * throws. Verified by inspecting `expo config --type public --json`, where webHost and
 * sentryDsn both come back as `{}` when their env vars are unset.
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const resolvedEnv = (stringOrNull(extra.env) as Env['env'] | null) ?? 'development';
const configuredApiUrl = stringOrNull(extra.apiUrl);
const resolvedApiUrl = configuredApiUrl ?? 'http://localhost:4000/api';

// Fail loudly in production rather than silently pointing at a dev API. A prod build
// that ships with a missing or localhost API URL is a release defect, not a fallback.
if (resolvedEnv === 'production') {
  if (!configuredApiUrl) {
    throw new Error('EXPO_PUBLIC_API_URL is required in a production build.');
  }
  if (isLocalApiUrl(resolvedApiUrl)) {
    throw new Error(`Refusing to use a local API URL in production: ${resolvedApiUrl}`);
  }
}

export const env: Env = {
  apiUrl: resolvedApiUrl,
  webHost: stringOrNull(extra.webHost),
  sentryDsn: stringOrNull(extra.sentryDsn),
  env: resolvedEnv,
};

export const isProd = env.env === 'production';
