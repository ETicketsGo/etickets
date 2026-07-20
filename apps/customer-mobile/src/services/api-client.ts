import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { env } from './env';
import { tokenStore, type AuthTokens } from './secure-store';

/**
 * The single Axios instance for the app. It talks ONLY to the existing NestJS API
 * (no new backend, no business logic here) — it attaches the access token, and on a
 * 401 performs a single-flight refresh via `POST /auth/refresh` (token rotation),
 * then retries. On refresh failure it clears tokens and lets the auth store log out.
 */
export const apiClient = axios.create({
  baseURL: env.apiUrl,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

// Called by the auth store when a refresh ultimately fails, so the UI can react.
let onAuthExpired: (() => void) | null = null;
export function setOnAuthExpired(cb: () => void) {
  onAuthExpired = cb;
}

apiClient.interceptors.request.use(async (config) => {
  const tokens = await tokenStore.get();
  if (tokens?.accessToken) {
    config.headers.set('authorization', `Bearer ${tokens.accessToken}`);
  }
  return config;
});

let refreshing: Promise<AuthTokens | null> | null = null;

async function refreshTokens(): Promise<AuthTokens | null> {
  const current = await tokenStore.get();
  if (!current) return null;
  try {
    // Bare axios (not apiClient) to avoid the interceptor recursing.
    const { data } = await axios.post<AuthTokens>(`${env.apiUrl}/auth/refresh`, {
      refreshToken: current.refreshToken,
    });
    if (!data?.accessToken || !data?.refreshToken) return null;
    await tokenStore.set(data);
    return data;
  } catch {
    await tokenStore.clear();
    return null;
  }
}

// Endpoints that must never trigger a refresh retry (they ARE the auth flow) —
// prevents any recursive refresh loop.
const AUTH_PATHS = ['/auth/login', '/auth/refresh', '/auth/register', '/auth/logout'];
const isAuthPath = (url?: string) => !!url && AUTH_PATHS.some((p) => url.includes(p));

apiClient.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as
      (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    const status = error.response?.status;

    if (status === 401 && original && !original._retried && !isAuthPath(original.url)) {
      original._retried = true;
      refreshing = refreshing ?? refreshTokens();
      const rotated = await refreshing;
      refreshing = null;
      if (rotated) {
        original.headers.set('authorization', `Bearer ${rotated.accessToken}`);
        return apiClient(original);
      }
      onAuthExpired?.();
    }
    return Promise.reject(error);
  },
);
