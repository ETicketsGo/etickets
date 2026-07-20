import Constants from 'expo-constants';

/** Typed, validated access to the app's public runtime config (from app.config.ts `extra`). */
interface Env {
  apiUrl: string;
  webHost: string | null;
  sentryDsn: string | null;
  env: 'development' | 'staging' | 'production';
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Env>;

export const env: Env = {
  apiUrl: extra.apiUrl ?? 'http://localhost:4000/api',
  webHost: extra.webHost ?? null,
  sentryDsn: extra.sentryDsn ?? null,
  env: (extra.env as Env['env']) ?? 'development',
};

export const isProd = env.env === 'production';
