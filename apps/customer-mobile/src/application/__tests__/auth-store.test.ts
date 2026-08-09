/** Auth store lifecycle: hydrate, login, logout, and forced expiry. */
import { useAuthStore } from '@/application/auth-store';
import { authRepository } from '@/data/auth-repository';

/**
 * The store now clears cached tickets on logout, which pulls in AsyncStorage — a native
 * module with no JS implementation under jest. Mocked here rather than in a global
 * setup file so the dependency stays visible at the point that created it.
 */
const mockClearAllTickets = jest.fn(async () => undefined);
jest.mock('@/services/ticket-cache', () => ({
  clearAllTickets: () => mockClearAllTickets(),
}));

const tokenState: { tokens: { accessToken: string; refreshToken: string } | null } = {
  tokens: null,
};

// The snapshot lives in the same module as the tokens and is cleared with them, so the
// mock mirrors that: tokenStore.clear() must also drop the snapshot, or a test could show
// a session surviving a real logout.
const userState: { snapshot: unknown } = { snapshot: null };

jest.mock('@/services/secure-store', () => ({
  tokenStore: {
    get: jest.fn(async () => tokenState.tokens),
    set: jest.fn(async (t) => {
      tokenState.tokens = t;
    }),
    clear: jest.fn(async () => {
      tokenState.tokens = null;
      userState.snapshot = null;
    }),
  },
  sessionUserStore: {
    get: jest.fn(async () => userState.snapshot),
    set: jest.fn(async (u) => {
      userState.snapshot = u;
    }),
    clear: jest.fn(async () => {
      userState.snapshot = null;
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
  userState.snapshot = null;
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

it('wipes every account’s cached tickets on a deliberate logout', async () => {
  mockClearAllTickets.mockClear();
  await useAuthStore.getState().login({ email: 'a@b.com', password: 'x' });

  await useAuthStore.getState().logout();

  expect(mockClearAllTickets).toHaveBeenCalledTimes(1);
});

it('KEEPS cached tickets when a session merely expires', () => {
  mockClearAllTickets.mockClear();

  useAuthStore.getState().expire();

  // An expiry is usually a phone that has been offline — precisely when someone needs
  // the ticket they already downloaded. Only a deliberate sign-out clears the wallet.
  expect(mockClearAllTickets).not.toHaveBeenCalled();
});

/**
 * A network failure and a rejected token both arrive as a thrown error, and the store used
 * to treat them identically: clear the keychain and show the sign-in screen.
 *
 * On a real Android device in aeroplane mode that deleted a valid refresh token on launch,
 * so the tickets cached on the phone for exactly that situation became unreachable — and
 * because the token was gone, the session did not come back when signal did. These pin the
 * distinction. The AxiosError shapes are the real ones: no `response` for a network
 * failure, a populated `response` for a refusal.
 */
describe('hydrate() with an unreachable server', () => {
  const { AxiosError } = jest.requireActual('axios') as typeof import('axios');

  const unreachable = () => new AxiosError('Network Error', 'ERR_NETWORK');
  const rejected = () => {
    const e = new AxiosError('Unauthorized', 'ERR_BAD_REQUEST');
    e.response = { status: 401, data: {}, statusText: '', headers: {}, config: {} as never };
    return e;
  };

  // The module is mocked above, so this import resolves to the mock and `me` is a
  // jest.fn — no require() needed to reach it.
  const repo = () => authRepository as unknown as { me: jest.Mock };

  it('keeps the session and restores the cached user when the server cannot be reached', async () => {
    tokenState.tokens = { accessToken: 'a', refreshToken: 'r' };
    userState.snapshot = user;
    repo().me.mockRejectedValueOnce(unreachable());

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user).toEqual(user);
    // The part that actually mattered on the device: the token is still there.
    expect(tokenState.tokens).toEqual({ accessToken: 'a', refreshToken: 'r' });
  });

  it('keeps the tokens even with no cached user, so the next online launch recovers', async () => {
    tokenState.tokens = { accessToken: 'a', refreshToken: 'r' };
    userState.snapshot = null;
    repo().me.mockRejectedValueOnce(unreachable());

    await useAuthStore.getState().hydrate();

    // Nothing to show, so no session on screen — but nothing destroyed either.
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(tokenState.tokens).not.toBeNull();
  });

  it('still clears everything when the SERVER rejects the token', async () => {
    tokenState.tokens = { accessToken: 'a', refreshToken: 'r' };
    userState.snapshot = user;
    repo().me.mockRejectedValueOnce(rejected());

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().user).toBeNull();
    expect(tokenState.tokens).toBeNull();
    // A 401 is the server disowning the session, so the snapshot must go with it —
    // otherwise the next offline launch would resurrect a session the server refused.
    expect(userState.snapshot).toBeNull();
  });

  it('records a snapshot on a successful hydrate, so a later offline launch has one', async () => {
    tokenState.tokens = { accessToken: 'a', refreshToken: 'r' };
    userState.snapshot = null;

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(userState.snapshot).toEqual(user);
  });

  it('records a snapshot on login', async () => {
    await useAuthStore.getState().login({ email: 'a@b.com', password: 'x' } as never);
    expect(userState.snapshot).toEqual(user);
  });
});
