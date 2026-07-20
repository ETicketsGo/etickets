/**
 * Foundation tests for the auth store lifecycle. Prepared for `npm run test:mobile`
 * (jest-expo); run in CI (mobile-ci.yml) and on a dev machine — not executed in the
 * headless environment where this code was authored.
 */
import { useAuthStore } from '@/application/auth-store';

const tokenState: { tokens: { accessToken: string; refreshToken: string } | null } = {
  tokens: null,
};

jest.mock('@/services/secure-store', () => ({
  tokenStore: {
    get: jest.fn(async () => tokenState.tokens),
    set: jest.fn(async (t) => {
      tokenState.tokens = t;
    }),
    clear: jest.fn(async () => {
      tokenState.tokens = null;
    }),
  },
}));

const user = { id: 'u1', email: 'a@b.com', fullName: 'A B', roles: ['CUSTOMER'] };
jest.mock('@/data/auth-repository', () => ({
  authRepository: {
    login: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r', user })),
    me: jest.fn(async () => user),
    logout: jest.fn(async () => undefined),
  },
}));

beforeEach(() => {
  tokenState.tokens = null;
  useAuthStore.setState({ status: 'loading', user: null });
});

describe('auth store', () => {
  it('hydrate() → unauthenticated when no tokens', async () => {
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });

  it('hydrate() → authenticated when a token resolves a user', async () => {
    tokenState.tokens = { accessToken: 'a', refreshToken: 'r' };
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user?.id).toBe('u1');
  });

  it('login() stores tokens and sets the user', async () => {
    await useAuthStore.getState().login({ email: 'a@b.com', password: 'x' });
    expect(tokenState.tokens).toEqual({ accessToken: 'a', refreshToken: 'r' });
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('logout() clears tokens and returns to unauthenticated', async () => {
    tokenState.tokens = { accessToken: 'a', refreshToken: 'r' };
    useAuthStore.setState({ status: 'authenticated', user });
    await useAuthStore.getState().logout();
    expect(tokenState.tokens).toBeNull();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });

  it('expire() clears the session once', () => {
    useAuthStore.setState({ status: 'authenticated', user });
    useAuthStore.getState().expire();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().user).toBeNull();
  });
});
