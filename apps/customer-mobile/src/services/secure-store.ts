import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { AuthTokens } from '@eticketsgo/shared-types';

/**
 * Token storage.
 *
 * On iOS and Android this is the device keychain/keystore via Expo Secure Store —
 * hardware-backed, and the only place the refresh token is ever written. It is never
 * placed in AsyncStorage.
 *
 * ── WEB ───────────────────────────────────────────────────────────────────────────
 * expo-secure-store has NO web implementation: calling it throws
 * "getValueWithKeyAsync is not a function". The app declares web support (Metro
 * bundler, static output) and is exported to web for preview and smoke testing, so
 * that throw took down the entire app — session hydration runs before first paint, so
 * the result was a blank page, not a degraded one. Found by running the exported
 * bundle in a browser; no amount of typechecking would have shown it.
 *
 * Web therefore gets an in-memory store. That is a deliberate choice rather than a
 * stopgap: the obvious alternative is localStorage, and putting a refresh token there
 * exposes it to every XSS on the origin. A preview surface that forgets the session on
 * reload is the correct trade — web is not a shipping target for this app.
 *
 * ── FAILURE TOLERANCE ─────────────────────────────────────────────────────────────
 * Every read and write is wrapped. A keychain read can fail on a real device too — a
 * restored backup with an unreadable entry, a keystore invalidated by a biometric
 * change — and the right outcome for "cannot read the token" is "treat the user as
 * signed out", never "fail to start".
 */
const ACCESS_KEY = 'etg_access';
const REFRESH_KEY = 'etg_refresh';

export type { AuthTokens };

const isWeb = Platform.OS === 'web';

/** Web-only, deliberately non-persistent. See the note above. */
let memoryTokens: AuthTokens | null = null;

export const tokenStore = {
  async get(): Promise<AuthTokens | null> {
    if (isWeb) return memoryTokens;
    try {
      const [accessToken, refreshToken] = await Promise.all([
        SecureStore.getItemAsync(ACCESS_KEY),
        SecureStore.getItemAsync(REFRESH_KEY),
      ]);
      if (!accessToken || !refreshToken) return null;
      return { accessToken, refreshToken };
    } catch {
      // Unreadable keychain: the user is signed out, not stuck on a splash screen.
      return null;
    }
  },

  async set(tokens: AuthTokens): Promise<void> {
    if (isWeb) {
      memoryTokens = tokens;
      return;
    }
    try {
      await Promise.all([
        SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
        SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
      ]);
    } catch {
      // A failed write means the session will not survive a restart. Better than
      // rejecting a sign-in that otherwise succeeded.
      memoryTokens = tokens;
    }
  },

  async clear(): Promise<void> {
    memoryTokens = null;
    if (isWeb) return;
    try {
      await Promise.all([
        SecureStore.deleteItemAsync(ACCESS_KEY),
        SecureStore.deleteItemAsync(REFRESH_KEY),
      ]);
    } catch {
      // Nothing further to do; get() fails closed anyway.
    }
  },
};
