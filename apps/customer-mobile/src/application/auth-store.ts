import { create } from 'zustand';
import type { LoginInput, RegisterInput } from '@eticketsgo/validation';
import { tokenStore } from '@/services/secure-store';
import { authRepository, type AuthUser } from '@/data/auth-repository';
import { clearAllTickets } from '@/services/ticket-cache';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  /** Hydrate from secure storage on launch; resolve the current user if a token exists. */
  hydrate: () => Promise<void>;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  /** Called by the API client when a refresh fails — force logout. */
  expire: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  user: null,

  /**
   * Resolve the session on launch.
   *
   * The whole body is guarded, and that is load-bearing rather than defensive habit:
   * the root layout holds the splash screen until `status` leaves 'loading', so ANY
   * throw in here means the app never paints. That is not hypothetical — reading the
   * token threw on web (expo-secure-store has no web build) and the app rendered a
   * blank page until it was found by running the exported bundle. Whatever goes wrong,
   * the outcome must be "signed out and running", never "stuck on a splash screen".
   */
  hydrate: async () => {
    try {
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
    } catch {
      set({ status: 'unauthenticated', user: null });
    }
  },

  login: async (input) => {
    const result = await authRepository.login(input);
    await tokenStore.set({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    const user = result.user ?? (await authRepository.me());
    set({ status: 'authenticated', user });
  },

  /**
   * Register and sign in in one step. The API returns the same token pair as login, so
   * a newly registered user is not made to type the password they just chose.
   */
  register: async (input) => {
    const result = await authRepository.register(input);
    await tokenStore.set({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    const user = result.user ?? (await authRepository.me());
    set({ status: 'authenticated', user });
  },

  logout: async () => {
    const tokens = await tokenStore.get();
    if (tokens) await authRepository.logout(tokens.refreshToken).catch(() => undefined);
    await tokenStore.clear();
    // Every account's cached tickets, not just this one's. Someone signing out of a
    // shared device should not leave a readable wallet behind for the next person.
    await clearAllTickets();
    set({ status: 'unauthenticated', user: null });
  },

  expire: () => {
    void tokenStore.clear();
    // A session that expired is not a deliberate sign-out, so the cached tickets are
    // deliberately KEPT: the common cause is a phone that has been offline for a while,
    // and that is exactly when someone needs to show a ticket they already downloaded.
    // They are still namespaced by user id and are wiped on a real logout.
    set({ status: 'unauthenticated', user: null });
  },
}));
