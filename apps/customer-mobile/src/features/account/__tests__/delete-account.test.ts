import { AxiosError, AxiosHeaders } from 'axios';
import { deleteAccount, isDeletionConfirmed } from '../delete-account';

/**
 * Deletion is irreversible and, on the client, the whole risk is leaving data behind.
 * These tests are mostly "did the device actually get scrubbed".
 */

const mockDelete = jest.fn();
jest.mock('@/services/api-client', () => ({
  apiClient: { delete: (...args: unknown[]) => mockDelete(...args) },
}));

const mockClearTokens = jest.fn(async () => undefined);
jest.mock('@/services/secure-store', () => ({
  tokenStore: { clear: () => mockClearTokens() },
}));

const mockClearTickets = jest.fn(async () => undefined);
jest.mock('@/services/ticket-cache', () => ({
  clearAllTickets: () => mockClearTickets(),
}));

const mockCancelQueries = jest.fn();
const mockClearQueries = jest.fn();
jest.mock('@/application/query-client', () => ({
  queryClient: {
    cancelQueries: () => mockCancelQueries(),
    clear: () => mockClearQueries(),
  },
}));

function httpError(status: number, data?: unknown): AxiosError {
  const err = new AxiosError('failed');
  err.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDelete.mockResolvedValue({ data: { status: 'DELETED' } });
});

describe('confirmation phrase', () => {
  it('accepts the exact word regardless of case or padding', () => {
    expect(isDeletionConfirmed('DELETE')).toBe(true);
    expect(isDeletionConfirmed('delete')).toBe(true);
    expect(isDeletionConfirmed('  Delete  ')).toBe(true);
  });

  it('rejects anything else, including near-misses', () => {
    // Typing a specific word is what makes this deliberate rather than a mis-tap.
    for (const input of ['', 'DELET', 'DELETED', 'yes', 'D E L E T E']) {
      expect(isDeletionConfirmed(input)).toBe(false);
    }
  });
});

describe('successful deletion', () => {
  it('calls DELETE /users/me', async () => {
    await deleteAccount();

    expect(mockDelete).toHaveBeenCalledWith('/users/me', { data: {} });
  });

  it('passes a reason when one is given', async () => {
    await deleteAccount('PRIVACY');

    expect(mockDelete).toHaveBeenCalledWith('/users/me', { data: { reason: 'PRIVACY' } });
  });

  it('clears credentials, cached tickets and every query cache', async () => {
    const outcome = await deleteAccount();

    expect(outcome).toEqual({ kind: 'deleted' });
    expect(mockClearTokens).toHaveBeenCalled();
    // Leaving a cached wallet behind would mean the app still showing someone's tickets
    // and name after they asked for all of it to be removed.
    expect(mockClearTickets).toHaveBeenCalled();
    expect(mockClearQueries).toHaveBeenCalled();
  });

  it('cancels in-flight queries before clearing, so nothing repopulates the cache', async () => {
    await deleteAccount();

    expect(mockCancelQueries).toHaveBeenCalled();
  });
});

describe('401 after deletion means it worked', () => {
  it('treats 401 as success and still scrubs the device', async () => {
    // The API revokes the session as part of deleting, and the JWT strategy now checks
    // account status per request. So a retry after a dropped response — the exact case
    // a flaky mobile connection produces — comes back 401 because the deletion already
    // happened. Reporting that as a failure would strand the user on an error for an
    // account that no longer exists.
    mockDelete.mockRejectedValue(httpError(401));

    const outcome = await deleteAccount();

    expect(outcome).toEqual({ kind: 'deleted' });
    expect(mockClearTokens).toHaveBeenCalled();
    expect(mockClearTickets).toHaveBeenCalled();
  });
});

describe('blocked deletion', () => {
  it('surfaces the API message verbatim on 409', async () => {
    const message =
      'You are the only owner of an organization. Transfer ownership to another owner before deleting your account.';
    mockDelete.mockRejectedValue(httpError(409, { code: 'ACCOUNT_DELETION_BLOCKED', message }));

    const outcome = await deleteAccount();

    // The server's message names the fix; paraphrasing it would lose that.
    expect(outcome).toEqual({ kind: 'blocked', message });
  });

  it('does NOT scrub the device when deletion was refused', async () => {
    mockDelete.mockRejectedValue(httpError(409, { message: 'blocked' }));

    await deleteAccount();

    // The account still exists and the session is still valid — wiping here would sign
    // someone out of an account they still have.
    expect(mockClearTokens).not.toHaveBeenCalled();
    expect(mockClearTickets).not.toHaveBeenCalled();
  });

  it('falls back to a usable message when the body has none', async () => {
    mockDelete.mockRejectedValue(httpError(409, {}));

    const outcome = await deleteAccount();

    expect(outcome.kind).toBe('blocked');
  });
});

describe('failures', () => {
  it('reports a network failure without scrubbing anything', async () => {
    mockDelete.mockRejectedValue(new AxiosError('Network Error'));

    const outcome = await deleteAccount();

    expect(outcome.kind).toBe('failed');
    // The request may never have reached the server; the account probably still exists.
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  it('reports a 500 as retryable rather than as deleted', async () => {
    mockDelete.mockRejectedValue(httpError(500));

    const outcome = await deleteAccount();

    expect(outcome.kind).toBe('failed');
    expect(mockClearTickets).not.toHaveBeenCalled();
  });
});
