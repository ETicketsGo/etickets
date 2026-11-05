// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api, HUMAN_CHECK_HEADER } from './api';
import { HUMAN_CHECK_LABELS, HumanCheckProvider, TURNSTILE_SCRIPT_URL } from './human-check';

/*
  The dialog end to end in a browser-like page: an API refusal opens it, a solved widget closes
  it and the request is repeated with the token; a script that cannot load is said in words,
  with a working "Try again".
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const required = () =>
  json(428, {
    code: 'HUMAN_CHECK_REQUIRED',
    message: 'Please confirm you are a person, then try again.',
    details: { action: 'login', siteKey: 'site-key' },
  });

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <HumanCheckProvider>
        <p>page</p>
      </HumanCheckProvider>,
    );
  });
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  delete window.turnstile;
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  vi.unstubAllGlobals();
});

describe('HumanCheckProvider', () => {
  it('draws the widget for the asked action and repeats the request with its token', async () => {
    const render = vi.fn((_el: HTMLElement, opts: { callback?: (t: string) => void }) => {
      setTimeout(() => opts.callback?.('solved-token'), 0);
      return 'w1';
    });
    window.turnstile = { render, remove: vi.fn(), reset: vi.fn() };
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(required)
      .mockImplementationOnce(() => json(200, { accessToken: 'a', refreshToken: 'r' }));
    vi.stubGlobal('fetch', fetchMock);
    await mount();

    const result = api.auth.login({ email: 'a@b.test', password: 'x' });
    await flush();
    await flush();
    await expect(result).resolves.toEqual({ accessToken: 'a', refreshToken: 'r' });
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][1]).toMatchObject({
      sitekey: 'site-key',
      action: 'login',
      appearance: 'interaction-only',
    });
    expect(
      new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get(HUMAN_CHECK_HEADER),
    ).toBe('solved-token');
  });

  it('says in words when the script cannot load, and Try again loads it again', async () => {
    vi.stubGlobal('fetch', vi.fn(required));
    await mount();
    const result = api.auth.login({ email: 'a@b.test', password: 'x' }).catch((e) => e);
    await flush();

    const script = document.head.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_URL}"]`,
    );
    expect(script).not.toBeNull();
    await act(async () => {
      script!.dispatchEvent(new Event('error'));
    });
    expect(document.body.textContent).toContain(HUMAN_CHECK_LABELS.failed);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(HUMAN_CHECK_LABELS.failed);

    const retry = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === HUMAN_CHECK_LABELS.retry,
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    // A fresh script tag: the failed load was forgotten rather than cached.
    expect(document.head.querySelectorAll(`script[src="${TURNSTILE_SCRIPT_URL}"]`)).toHaveLength(1);
    expect(document.body.textContent).not.toContain(HUMAN_CHECK_LABELS.failed);

    // Cancel hands the original refusal back to the form.
    const cancel = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === HUMAN_CHECK_LABELS.cancel,
    );
    await act(async () => cancel!.click());
    expect(await result).toMatchObject({ code: 'HUMAN_CHECK_REQUIRED' });
  });
});
