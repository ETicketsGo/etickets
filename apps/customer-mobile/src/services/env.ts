import Constants from 'expo-constants';
import { isLocalApiUrl } from '@eticketsgo/shared-types';

/** Typed, validated access to the app's public runtime config (from app.config.ts `extra`). */
interface Env {
  apiUrl: string;
  webHost: string | null;
  sentryDsn: string | null;
  env: 'development' | 'staging' | 'production';
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Env>;

const resolvedEnv = (extra.env as Env['env']) ?? 'development';
const resolvedApiUrl = extra.apiUrl ?? 'http://localhost:4000/api';

// Fail loudly in production rather than silently pointing at a dev API. A prod build
// that ships with a missing or localhost API URL is a release defect, not a fallback.
if (resolvedEnv === 'production') {
  if (!extra.apiUrl) {
    throw new Error('EXPO_PUBLIC_API_URL is required in a production build.');
  }
  if (isLocalApiUrl(resolvedApiUrl)) {
    throw new Error(`Refusing to use a local API URL in production: ${resolvedApiUrl}`);
  }
}

export const env: Env = {
  apiUrl: resolvedApiUrl,
  webHost: extra.webHost ?? null,
  sentryDsn: extra.sentryDsn ?? null,
  env: resolvedEnv,
};

export const isProd = env.env === 'production';
