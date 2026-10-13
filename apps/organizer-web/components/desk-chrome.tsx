'use client';

import Link from 'next/link';
import { Bell, Monitor, Moon, Sun } from 'lucide-react';
import { useColorScheme, type ColorScheme } from '@eticketsgo/web-kit';

/*
  ── THE DESK'S TOP-BAR CONTROLS ─────────────────────────────────────────────────────
  The organizer console paints its shell in the brand layer (`AppShell appearance="desk"`,
  docs/design/DESIGN-SYSTEM.md). The shell's own controls follow it; these two are the slots
  the organizer app fills, so they are drawn here in the same tokens rather than in the
  classic console's teal. Same roles, names and behaviour as web-kit's `ColorSchemeSwitch` and
  `NotificationsButton` (`masthead-does-not-block-controls.spec.ts` finds the radios by name).

  Kept local to the organizer until the design system ships them: they are listed in the
  slice's report for D-1 to absorb.
*/

const RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas';

const OPTIONS: { value: ColorScheme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'Match system', Icon: Monitor },
];

/** Light, dark, or the machine's choice: a segmented radiogroup on the paper. */
export function DeskSchemeSwitch() {
  const { scheme, setScheme } = useColorScheme();
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="flex shrink-0 items-center gap-1 rounded-brand-control border border-brand-line bg-brand-surface p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = scheme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setScheme(value)}
            // Selected is shown by fill AND by aria-checked, never by colour alone.
            className={`flex h-8 w-8 items-center justify-center rounded-[0.375rem] transition-colors duration-150 motion-reduce:transition-none ${RING} ${
              active
                ? 'bg-brand-action text-brand-on-action'
                : 'text-brand-ink-3 hover:bg-brand-sunken hover:text-brand-ink'
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The bell, with the organizer stream's real unread count - or no number at all while it is
 * unknown. The count is ink on paper with words for assistive technology; red is kept for
 * things that are wrong, and an unread message is not.
 */
export function DeskNotificationsButton({ href, unread }: { href: string; unread?: number }) {
  const n = unread ?? 0;
  const label = n > 0 ? `Notifications, ${n} unread` : 'Notifications';
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-brand-control text-brand-ink-2 transition-colors duration-150 hover:bg-brand-sunken hover:text-brand-ink ${RING}`}
    >
      <Bell className="h-[1.125rem] w-[1.125rem]" aria-hidden />
      {n > 0 && (
        <span
          aria-hidden
          className="absolute right-0.5 top-0.5 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-brand-ink px-1 text-[0.625rem] font-bold tabular-nums leading-none text-brand-canvas ring-2 ring-brand-canvas"
        >
          {n > 99 ? '99+' : n}
        </span>
      )}
    </Link>
  );
}
