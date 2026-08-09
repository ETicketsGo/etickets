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
const USER_KEY = 'etg_user';

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
    await sessionUserStore.clear();
  },
};

/**
 * The last known signed-in user, so a launch with no signal can still show a session.
 *
 * WHY THIS EXISTS. Hydration used to call `GET /auth/me` and treat any failure as "not
 * signed in". Offline that call cannot succeed, so opening the app without signal showed
 * the "Sign in to see your bookings" screen — and signing in needs the network, so the
 * cached tickets became unreachable at exactly the moment they matter, standing at a gate
 * with no bars. The ticket cache is also namespaced by user id, so without a user there
 * is nothing to look the cache up by even if the screen were reachable.
 *
 * Stored beside the tokens in the keychain rather than in AsyncStorage: it is session
 * PII (email, name) that should die with the session, `tokenStore.clear()` removes it,
 * and the object is a few hundred bytes — far below the ~2KB where SecureStore starts
 * warning, which is why the tickets themselves live in AsyncStorage instead.
 *
 * It is a CONVENIENCE COPY, never an authority. It says who was signed in last, not that
 * the session is still valid — only the API can say that, and it does so the moment
 * connectivity returns and the first authenticated request either succeeds or 401s.
 */
export interface SessionUserSnapshot {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  organizationId?: string | null;
}

let memoryUser: SessionUserSnapshot | null = null;

const isSnapshot = (v: unknown): v is SessionUserSnapshot => {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.email === 'string' &&
    typeof c.fullName === 'string' &&
    Array.isArray(c.roles)
  );
};

export const sessionUserStore = {
  async get(): Promise<SessionUserSnapshot | null> {
    if (isWeb) return memoryUser;
    try {
      const raw = await SecureStore.getItemAsync(USER_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      // A snapshot written by an older version may not match; discarding it costs one
      // online launch, whereas trusting it could put a malformed user into the store.
      return isSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },

  async set(user: SessionUserSnapshot): Promise<void> {
    memoryUser = user;
    if (isWeb) return;
    try {
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
    } catch {
      // Keeping the in-memory copy is enough for this run; the next successful online
      // launch writes it again.
    }
  },

  async clear(): Promise<void> {
    memoryUser = null;
    if (isWeb) return;
    try {
      await SecureStore.deleteItemAsync(USER_KEY);
    } catch {
      // get() fails closed.
    }
  },
};
