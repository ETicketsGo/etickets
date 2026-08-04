import * as SecureStore from 'expo-secure-store';
import type { AuthTokens } from '@eticketsgo/shared-types';

/**
 * Token storage in the device keychain/keystore (Expo Secure Store). The mobile
 * equivalent of the web client's localStorage token store — same token contract
 * (reused from shared-types), hardware-backed. Only the refresh + access token pair
 * is stored here; nothing else. Refresh tokens are NEVER placed in AsyncStorage.
 */
const ACCESS_KEY = 'etg_access';
const REFRESH_KEY = 'etg_refresh';

export type { AuthTokens };

export const tokenStore = {
  async get(): Promise<AuthTokens | null> {
    const [accessToken, refreshToken] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_KEY),
      SecureStore.getItemAsync(REFRESH_KEY),
    ]);
    if (!accessToken || !refreshToken) return null;
    return { accessToken, refreshToken };
  },
  async set(tokens: AuthTokens): Promise<void> {
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
      SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
    ]);
  },
  async clear(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY),
      SecureStore.deleteItemAsync(REFRESH_KEY),
    ]);
  },
};
