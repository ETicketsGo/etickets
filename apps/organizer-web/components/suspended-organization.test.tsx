// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SuspendedOrganizationScreen } from './suspended-organization';

/*
  The screen a member of a SUSPENDED organization sees instead of the console (owner decision,
  2026-10-26): what happened, a way to support, a way out - and nothing else.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(onSignOut = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SuspendedOrganizationScreen
        organizations={[{ id: 'org-1', name: 'Closed Hall' }]}
        storefront="https://www.eticketsgo.com"
        onSignOut={onSignOut}
      />,
    );
  });
  return { onSignOut };
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

describe('SuspendedOrganizationScreen', () => {
  it('says the organization is suspended and offers no console navigation', async () => {
    await mount();
    expect(host!.textContent).toContain('This organization is suspended');
    expect(host!.textContent).toContain('Closed Hall');
    // Only two ways out: the storefront contact page, and nothing that leads into the console.
    const links = [...host!.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://www.eticketsgo.com/contact']);
    expect(host!.querySelector('nav')).toBeNull();
  });

  it('signs out from the button', async () => {
    const { onSignOut } = await mount();
    const button = host!.querySelector<HTMLButtonElement>('[data-testid="suspension-sign-out"]')!;
    await act(async () => button.click());
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('sends an appeal to support, filed under the organization', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'f1', reference: 'ETG-SUP-1', status: 'OPEN' }), {
          status: 201,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    const box = host!.querySelector<HTMLTextAreaElement>('#suspension-message')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(box, 'Please look at our account again.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host!.querySelector('form')!.requestSubmit();
    });
    await act(async () => new Promise((r) => setTimeout(r, 0)));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/support$/);
    const body = JSON.parse(String(init.body));
    expect(body.kind).toBe('CONTACT');
    expect(body.metadata).toMatchObject({
      source: 'organizer-suspended',
      organizationId: 'org-1',
    });
    expect(host!.textContent).toContain('We have your message');
  });
});
