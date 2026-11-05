import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, HUMAN_CHECK_HEADER, humanCheckChallengeFrom, setHumanCheckHandler } from './api';

/*
  The shared client's half of the human check: a 428 HUMAN_CHECK_REQUIRED asks the registered
  handler for a token and repeats the request ONCE with it; anything else is left alone.
*/
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const required = () =>
  json(428, {
    code: 'HUMAN_CHECK_REQUIRED',
    message: 'Please confirm you are a person, then try again.',
    details: { action: 'login', siteKey: 'site-key' },
  });

const sentToken = (call: unknown[]) =>
  new Headers((call[1] as RequestInit).headers).get(HUMAN_CHECK_HEADER);

afterEach(() => {
  setHumanCheckHandler(null);
  vi.unstubAllGlobals();
});

describe('human-check retry', () => {
  it('asks the handler once, then repeats the request with the token', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(required)
      .mockImplementationOnce(() => json(200, { accessToken: 'a', refreshToken: 'r' }));
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn(async () => 'solved-token');
    setHumanCheckHandler(handler);

    await expect(api.auth.login({ email: 'a@b.test', password: 'x' })).resolves.toEqual({
      accessToken: 'a',
      refreshToken: 'r',
    });
    expect(handler).toHaveBeenCalledWith({ action: 'login', siteKey: 'site-key' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentToken(fetchMock.mock.calls[0])).toBeNull();
    expect(sentToken(fetchMock.mock.calls[1])).toBe('solved-token');
    // The body is sent again unchanged.
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(
      (fetchMock.mock.calls[0][1] as RequestInit).body,
    );
  });

  it('does not loop: a second refusal surfaces as the error', async () => {
    const fetchMock = vi.fn(required);
    vi.stubGlobal('fetch', fetchMock);
    setHumanCheckHandler(async () => 'token');
    await expect(api.auth.login({ email: 'a@b.test', password: 'x' })).rejects.toMatchObject({
      code: 'HUMAN_CHECK_REQUIRED',
      status: 428,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the refusal when the person cancels, and when no app registered a handler', async () => {
    const fetchMock = vi.fn(required);
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.auth.login({ email: 'a@b.test', password: 'x' })).rejects.toMatchObject({
      code: 'HUMAN_CHECK_REQUIRED',
    });
    setHumanCheckHandler(async () => null);
    await expect(api.auth.login({ email: 'a@b.test', password: 'x' })).rejects.toMatchObject({
      code: 'HUMAN_CHECK_REQUIRED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves every other refusal alone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json(401, { code: 'INVALID_CREDENTIALS', message: 'Wrong.' })),
    );
    const handler = vi.fn(async () => 'token');
    setHumanCheckHandler(handler);
    await expect(api.auth.login({ email: 'a@b.test', password: 'x' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('humanCheckChallengeFrom', () => {
  it('reads a challenge from 428 REQUIRED and 403 FAILED only', () => {
    const details = { action: 'otp', siteKey: 'k' };
    expect(humanCheckChallengeFrom(428, { code: 'HUMAN_CHECK_REQUIRED', details })).toEqual({
      action: 'otp',
      siteKey: 'k',
    });
    expect(humanCheckChallengeFrom(403, { code: 'HUMAN_CHECK_FAILED', details })).toEqual({
      action: 'otp',
      siteKey: 'k',
    });
    expect(humanCheckChallengeFrom(403, { code: 'FORBIDDEN', details })).toBeNull();
    expect(humanCheckChallengeFrom(428, { code: 'HUMAN_CHECK_REQUIRED', details: {} })).toBeNull();
  });
});
