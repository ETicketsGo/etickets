import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError, setMfaSetupHandler, setStepUpHandler } from './api';

/*
  The two client-side halves of admin MFA that are not the sign-in form itself:
  - a customer/organizer surface must never store "tokens" that are really a challenge;
  - a step-up refusal is retried exactly once, and only if a handler is registered.
*/
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

afterEach(() => {
  setStepUpHandler(null);
  setMfaSetupHandler(null);
  vi.unstubAllGlobals();
});

describe('login on a non-admin surface', () => {
  it('refuses a second-factor challenge instead of returning it as tokens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json(200, { mfaRequired: true, challengeToken: 'c', methods: ['totp'] })),
    );
    const err = await api.auth.login({ email: 'a@b.test', password: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).code).toBe('MFA_REQUIRED');
  });

  it('still returns tokens for everyone else', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json(200, { accessToken: 'a', refreshToken: 'r' })),
    );
    expect(await api.auth.login({ email: 'a@b.test', password: 'x' })).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
    });
  });

  it('signIn (the admin console) returns the challenge for the form to complete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json(200, { mfaRequired: true, challengeToken: 'c', methods: ['totp'] })),
    );
    expect(await api.auth.signIn({ email: 'a@b.test', password: 'x' })).toMatchObject({
      mfaRequired: true,
      challengeToken: 'c',
    });
  });
});

describe('step-up retry', () => {
  const refused = () =>
    json(403, {
      code: 'MFA_STEP_UP_REQUIRED',
      message: 'Confirm your authenticator code to do this.',
    });

  it('asks once, then repeats the request and returns its answer', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(refused)
      .mockImplementationOnce(() => json(200, { success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn(async () => true);
    setStepUpHandler(handler);
    await expect(api.admin.staff.resetMfa('u1')).resolves.toEqual({ success: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not loop: a second refusal surfaces as an error', async () => {
    const fetchMock = vi.fn(refused);
    vi.stubGlobal('fetch', fetchMock);
    setStepUpHandler(async () => true);
    await expect(api.admin.staff.resetMfa('u1')).rejects.toMatchObject({
      code: 'MFA_STEP_UP_REQUIRED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the refusal when the person cancels, and when no console registered a handler', async () => {
    vi.stubGlobal('fetch', vi.fn(refused));
    await expect(api.admin.staff.resetMfa('u1')).rejects.toMatchObject({
      code: 'MFA_STEP_UP_REQUIRED',
    });
    setStepUpHandler(async () => false);
    await expect(api.admin.staff.resetMfa('u1')).rejects.toMatchObject({
      code: 'MFA_STEP_UP_REQUIRED',
    });
  });
});

describe('sensitive action without an authenticator (MFA_ENROLLMENT=deferred)', () => {
  for (const code of ['MFA_SETUP_REQUIRED', 'MFA_NOT_CONFIGURED'] as const) {
    it(`${code}: tells the console once, does not repeat the request, and still fails`, async () => {
      const fetchMock = vi.fn(() => json(403, { code, message: 'Plain words.' }));
      vi.stubGlobal('fetch', fetchMock);
      const handler = vi.fn();
      setMfaSetupHandler(handler);
      setStepUpHandler(async () => true);
      await expect(api.admin.staff.resetMfa('u1')).rejects.toMatchObject({ code });
      expect(handler).toHaveBeenCalledWith(code, 'Plain words.');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it('surfaces the refusal as before when no console registered a handler', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json(403, { code: 'MFA_SETUP_REQUIRED', message: 'x' })),
    );
    await expect(api.admin.staff.resetMfa('u1')).rejects.toMatchObject({
      code: 'MFA_SETUP_REQUIRED',
    });
  });
});
