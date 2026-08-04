import { create } from 'zustand';
import type { LoginInput } from '@eticketsgo/validation';
import { tokenStore } from '@/services/secure-store';
import { authRepository, type AuthUser } from '@/data/auth-repository';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  /** Hydrate from secure storage on launch; resolve the current user if a token exists. */
  hydrate: () => Promise<void>;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  /** Called by the API client when a refresh fails — force logout. */
  expire: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  user: null,

  hydrate: async () => {
    const tokens = await tokenStore.get();
    if (!tokens) {
      set({ status: 'unauthenticated', user: null });
      return;
    }
    try {
      const user = await authRepository.me();
      set({ status: 'authenticated', user });
    } catch {
      await tokenStore.clear();
      set({ status: 'unauthenticated', user: null });
    }
  },

  login: async (input) => {
    const result = await authRepository.login(input);
    await tokenStore.set({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    const user = result.user ?? (await authRepository.me());
    set({ status: 'authenticated', user });
  },

  logout: async () => {
    const tokens = await tokenStore.get();
    if (tokens) await authRepository.logout(tokens.refreshToken).catch(() => undefined);
    await tokenStore.clear();
    set({ status: 'unauthenticated', user: null });
  },

  expire: () => {
    void tokenStore.clear();
    set({ status: 'unauthenticated', user: null });
  },
}));
