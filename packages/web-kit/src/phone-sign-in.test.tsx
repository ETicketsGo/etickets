// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PhoneCodeSignIn } from './phone-sign-in';

/*
  The organizer console's phone sign-in, in a browser-like page. A phone-only account has no
  email or password, so this is the only way such an organizer signs in on the console itself.
  It must use the storefront's routes, and hand a back-office account's second-factor
  challenge to the caller rather than treat it as a session.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(props: Partial<Parameters<typeof PhoneCodeSignIn>[0]> = {}) {
  const onTokens = vi.fn();
  const onChallenge = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<PhoneCodeSignIn onTokens={onTokens} onChallenge={onChallenge} {...props} />);
  });
  return { onTokens, onChallenge };
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** Type into a React-controlled field the way a person does. */
async function type(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

async function submit(selector: string) {
  const form = host!.querySelector<HTMLFormElement>(selector)!;
  await act(async () => {
    form.requestSubmit();
  });
  await flush();
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

async function sendAndVerify(verifyReply: () => Promise<Response>) {
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(() => json(201, { sent: true, expiresInMinutes: 10 }))
    .mockImplementationOnce(verifyReply);
  vi.stubGlobal('fetch', fetchMock);
  const handlers = await mount();
  await type(host!.querySelector<HTMLSelectElement>('#phone-country')!, 'US');
  await type(host!.querySelector<HTMLInputElement>('#phone')!, '4155550123');
  await submit('[data-testid="console-phone-form"]');
  expect(host!.textContent).toContain('We sent a code to +14155550123');
  await type(host!.querySelector<HTMLInputElement>('#phone-code')!, '424242');
  await submit('[data-testid="console-phone-code-form"]');
  return { fetchMock, ...handlers };
}

describe('PhoneCodeSignIn (organizer console)', () => {
  it('signs in through the same two routes the storefront uses', async () => {
    const tokens = { accessToken: 'a', refreshToken: 'r', isNewAccount: false };
    const { fetchMock, onTokens, onChallenge } = await sendAndVerify(() => json(201, tokens));
    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(String(requestUrl)).toMatch(/\/auth\/phone\/request-code$/);
    expect(JSON.parse(requestInit.body)).toEqual({ phone: '+14155550123' });
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[1];
    expect(String(verifyUrl)).toMatch(/\/auth\/phone\/verify$/);
    expect(JSON.parse(verifyInit.body)).toEqual({ phone: '+14155550123', code: '424242' });
    expect(onTokens).toHaveBeenCalledWith(tokens);
    expect(onChallenge).not.toHaveBeenCalled();
  });

  it("hands a back-office account's second-factor challenge on, never treating it as a session", async () => {
    const challenge = { mfaRequired: true, challengeToken: 'ch', methods: ['totp', 'recovery'] };
    const { onTokens, onChallenge } = await sendAndVerify(() => json(201, challenge));
    expect(onChallenge).toHaveBeenCalledWith(challenge);
    expect(onTokens).not.toHaveBeenCalled();
  });

  it('says plainly when no code can be sent, and offers email', async () => {
    const onUseEmail = vi.fn();
    vi.stubGlobal('fetch', vi.fn());
    await mount({ smsCountries: [], onUseEmail });
    expect(host!.querySelector('[data-testid="console-phone-unavailable"]')).not.toBeNull();
    expect(host!.querySelector('#phone')).toBeNull();
    const button = [...host!.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Use email instead'),
    )!;
    await act(async () => button.click());
    expect(onUseEmail).toHaveBeenCalled();
  });
});
