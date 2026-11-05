import { renderHook } from '@testing-library/react-native';
import { useDeepLinks } from '../use-deep-links';

/**
 * Signing in or out must not re-open the link that launched the app. The hook re-ran on
 * every sign-in change and re-read getInitialURL(), so signing out of Account opened the
 * film page the app had been launched with (seen on a moto g31).
 */

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

const mockGetInitialURL = jest.fn();
jest.mock('expo-linking', () => ({
  getInitialURL: () => mockGetInitialURL(),
  addEventListener: () => ({ remove: () => undefined }),
}));

jest.mock('@/services/env', () => ({
  env: { webHost: 'qa.eticketsgo.com', apiUrl: '', sentryDsn: null, env: 'staging' },
}));

let mockAuth = { isAuthenticated: true, status: 'authenticated' };
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => mockAuth }));

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockPush.mockReset();
  mockReplace.mockReset();
  mockGetInitialURL.mockReset().mockResolvedValue('etickets://movie/the-long-monsoon');
  mockAuth = { isAuthenticated: true, status: 'authenticated' };
});

describe('useDeepLinks', () => {
  it('opens the launch link once', async () => {
    await renderHook(() => useDeepLinks());
    await flush();
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('does not open the launch link again when the user signs out', async () => {
    const { rerender } = await renderHook(() => useDeepLinks());
    await flush();
    mockPush.mockClear();

    mockAuth = { isAuthenticated: false, status: 'unauthenticated' };
    await rerender({});
    await flush();

    expect(mockGetInitialURL).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
