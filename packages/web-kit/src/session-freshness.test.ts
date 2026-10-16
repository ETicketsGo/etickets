import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, takeSignedOutNotice, tokenStore } from './api';

/*
  The shared client against a stale session, with the network faked.

  Two defects from walking QA: an organizer's support request sent with an expired token must
  refresh and go through (the API now answers 401 there, and this is the half that turns 401
  into a retry), and a session that a team removal ended must close at once with the API's own
  sentence kept for the sign-in page, not loop through a refresh that cannot work.
*/

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('session freshness in the shared api client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    tokenStore.set({ accessToken: 'expired-access', refreshToken: 'good-refresh' } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a support request with an expired token refreshes and is sent as the signed-in person', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' }))
      .mockResolvedValueOnce(
        json(200, { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' }),
      )
      .mockResolvedValueOnce(json(201, { id: 'fb_1', status: 'NEW' }));

    const result = await api.support.submit({
      kind: 'CONTACT',
      subject: 'Walk',
      message: 'Please change this.',
    } as never);

    expect(result).toEqual({ id: 'fb_1', status: 'NEW' });
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/auth\/refresh$/);
    const retried = new Headers((fetchMock.mock.calls[2][1] as RequestInit).headers);
    expect(retried.get('authorization')).toBe('Bearer fresh-access');
  });

  it('ACCESS_REMOVED ends the session without a refresh and keeps the reason once', async () => {
    fetchMock.mockResolvedValueOnce(
      json(401, { code: 'ACCESS_REMOVED', message: 'You no longer have access to Walk Org.' }),
    );

    await expect(api.auth.me()).rejects.toMatchObject({ code: 'ACCESS_REMOVED', status: 401 });

    // One call: the refresh token went with the removal, so trying it would only fail.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenStore.access).toBeNull();
    expect(tokenStore.refresh).toBeNull();
    expect(takeSignedOutNotice()).toBe('You no longer have access to Walk Org.');
    expect(takeSignedOutNotice()).toBeNull();
  });

  it('an ordinary expiry that cannot refresh leaves no notice behind', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' }))
      .mockResolvedValueOnce(json(401, { code: 'INVALID_REFRESH_TOKEN', message: 'Expired' }));

    await expect(api.auth.me()).rejects.toMatchObject({ status: 401 });
    expect(tokenStore.access).toBeNull();
    expect(takeSignedOutNotice()).toBeNull();
  });
});
