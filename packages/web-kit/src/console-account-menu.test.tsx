// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConsoleAccountMenu } from './console-account-menu';

/*
  The account menu in both consoles' top bar: the owner holds several logins and could not tell
  which one was active. The menu must name the account by its address and role, open and close
  like a disclosure (Escape returns focus to the avatar), and sign out through the console's own
  handler.
*/

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

const trigger = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="account-menu-trigger"]')!;
const panel = () => document.querySelector<HTMLElement>('[data-testid="account-menu"]');
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
  });
};
const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === name,
  );

const USER = { fullName: 'Asha Rao', email: 'asha.rao@example.com' };

describe('ConsoleAccountMenu', () => {
  it('names the account by its address and role beside the avatar, and is closed at first', async () => {
    await render(<ConsoleAccountMenu user={USER} role="Owner" onSignOut={() => {}} />);
    const t = trigger();
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.getAttribute('aria-label')).toBe('Account menu, signed in as asha.rao@example.com');
    expect(t.getAttribute('title')).toBe('Asha Rao, asha.rao@example.com, Owner');
    expect(t.querySelector('[data-testid="account-name"]')?.textContent).toBe(
      'asha.rao@example.comOwner',
    );
    expect(t.textContent).toContain('AR');
    expect(panel()).toBeNull();
  });

  it('opens on a click to show the name, email and role, and closes on a second click', async () => {
    await render(<ConsoleAccountMenu user={USER} role="Super admin" onSignOut={() => {}} />);
    await click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe(panel()!.id);
    expect(panel()!.textContent).toContain('Signed in as');
    expect(panel()!.textContent).toContain('Asha Rao');
    const email = panel()!.querySelector('[data-testid="account-menu-email"]')!;
    expect(email.textContent).toBe('asha.rao@example.com');
    expect(email.getAttribute('title')).toBe('asha.rao@example.com');
    expect(panel()!.querySelector('[data-testid="account-menu-role"]')!.textContent).toBe(
      'Super admin',
    );
    await click(trigger());
    expect(panel()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape and gives focus back to the avatar', async () => {
    await render(<ConsoleAccountMenu user={USER} role="Owner" onSignOut={() => {}} />);
    await click(trigger());
    button('Sign out')!.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on a click outside', async () => {
    await render(<ConsoleAccountMenu user={USER} role="Owner" onSignOut={() => {}} />);
    await click(trigger());
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  it('signs out through the handler it was given', async () => {
    const onSignOut = vi.fn();
    await render(<ConsoleAccountMenu user={USER} role="Owner" onSignOut={onSignOut} />);
    await click(trigger());
    await click(button('Sign out')!);
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });

  it("shows the app's details and links, and hands details a way to close", async () => {
    await render(
      <ConsoleAccountMenu
        user={USER}
        role="Admin"
        links={[{ label: 'Account security', href: '/admin/security' }]}
        details={(close) => (
          <button type="button" onClick={close}>
            Switch to River Arts
          </button>
        )}
        onSignOut={() => {}}
      />,
    );
    await click(trigger());
    const link = Array.from(panel()!.querySelectorAll('a')).find(
      (a) => a.textContent === 'Account security',
    );
    expect(link?.getAttribute('href')).toBe('/admin/security');
    await click(button('Switch to River Arts')!);
    expect(panel()).toBeNull();
  });

  it('falls back to the name, then the phone number, when there is no email', async () => {
    await render(
      <ConsoleAccountMenu
        user={{ fullName: '', email: null, phone: '+14695884580' }}
        role={null}
        onSignOut={() => {}}
      />,
    );
    expect(trigger().getAttribute('aria-label')).toBe('Account menu, signed in as +1 469-588-4580');
    await click(trigger());
    expect(panel()!.querySelector('[data-testid="account-menu-email"]')!.textContent).toBe(
      '+1 469-588-4580',
    );
    expect(panel()!.querySelector('[data-testid="account-menu-role"]')).toBeNull();
  });
});
