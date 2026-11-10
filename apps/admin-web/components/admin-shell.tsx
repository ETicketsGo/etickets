'use client';

import { type ReactNode } from 'react';
import {
  AppShell,
  consoleAccountMenuMetaClass,
  useAuthUser,
  type ConsoleAccountLink,
} from '@eticketsgo/web-kit';
import { adminNavItems } from '@/lib/admin-nav';
import { adminAccountIdentity } from '@/lib/account-identity';
import { ColorSchemeSwitch } from './color-scheme-switch';

/**
 * The admin console's frame: the SAME shell the organizer console uses.
 *
 * ── WHY ADMIN NO LONGER HAS ITS OWN FRAME ──────────────────────────────────────────
 * It was built separately because the shared shell could not fold groups or collapse to a
 * rail. It now does both, better than this file did (a rail of named groups with flyouts
 * rather than twenty-five anonymous icons), so keeping a second frame would only mean the two
 * consoles drifting apart again. What is admin's own is the menu (`lib/admin-nav.ts`) and the
 * capability on each link, which the shell uses to list only what this operator can open.
 *
 * The names a test or a screen reader finds the controls by are kept: the navigation landmark
 * is "Admin", the phone drawer is "Admin menu", the menu button is "Toggle navigation".
 *
 * The brand is the shell's: the one ETicketsGo wordmark with "Admin" beside it, in place of the
 * old purple-to-blue gradient ticket and the favicon image that stood in for it (#431).
 */
const NAV = adminNavItems();

/**
 * The operator's own sign-in security. Every operator can open it (it needs no duty - see the
 * "My account" group in `admin-nav.ts`), so it is safe to offer to everybody.
 */
const ACCOUNT_LINKS: ConsoleAccountLink[] = [
  { label: 'Account security', href: '/admin/security' },
];

/**
 * What this operator may do here, in the account menu: "Holds every duty" for a super admin, the
 * duties they hold for anybody else. Words only; it opens nothing.
 */
function AdminDuties({ summary, duties }: { summary: string | null; duties: string[] }) {
  const meta = consoleAccountMenuMetaClass('classic');
  return (
    <div className="px-4 py-2" data-testid="account-menu-duties">
      <p className={meta}>{duties.length > 0 ? 'Your duties' : 'Duties'}</p>
      {summary && <p className="text-ui text-text-primary">{summary}</p>}
      {duties.length > 0 && (
        // Capped: an operator with many duties still reaches Sign out without scrolling the page.
        <ul className="max-h-40 overflow-y-auto text-ui text-text-primary">
          {duties.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const { user } = useAuthUser();
  const identity = adminAccountIdentity(user);
  return (
    <AppShell
      brand="Admin"
      nav={NAV}
      accountRole={identity.role}
      accountDetails={
        identity.summary || identity.duties.length > 0 ? (
          <AdminDuties summary={identity.summary} duties={identity.duties} />
        ) : undefined
      }
      accountLinks={ACCOUNT_LINKS}
      navLabel="Admin"
      drawerLabel="Admin menu"
      width="fluid"
      /*
        From `sm` up only. At 320-390px the brand, the menu button, three appearance buttons
        and Sign out do not fit on one line; on a phone the switch is in the drawer instead.
      */
      headerAccessory={<ColorSchemeSwitch className="hidden sm:flex" />}
      drawerAccessory={
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:hidden">
          <span className="text-sm text-text-secondary">Appearance</span>
          <ColorSchemeSwitch />
        </div>
      }
    >
      {children}
    </AppShell>
  );
}
