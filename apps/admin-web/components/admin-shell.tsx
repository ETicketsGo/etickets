'use client';

import { type ReactNode } from 'react';
import { AppShell } from '@eticketsgo/web-kit';
import { adminNavItems } from '@/lib/admin-nav';
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
 */
const NAV = adminNavItems();

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <AppShell
      brand="Admin"
      nav={NAV}
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
