import * as SecureStore from 'expo-secure-store';

/**
 * Token storage in the device keychain/keystore (Expo Secure Store). The mobile
 * equivalent of the web client's localStorage token store — same token contract,
 * hardware-backed. Never store anything but the auth tokens here.
 */
const ACCESS_KEY = 'etg_access';
const REFRESH_KEY = 'etg_refresh';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

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
