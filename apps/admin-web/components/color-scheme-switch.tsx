'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useColorScheme, type ColorScheme } from '@eticketsgo/web-kit';

const OPTIONS: { value: ColorScheme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'Match system', Icon: Monitor },
];

/**
 * Light, dark, or whatever the machine is doing - the same per-device preference the organizer
 * console has, read and written through the same web-kit hook and storage key.
 *
 * The admin console had no dark theme at all, although every token it uses already has a dark
 * value. Somebody working a late shift on the refund queue was the one person on the platform
 * who could not have it.
 *
 * Icons only, to stay small in the header (from `sm` up) and in the phone menu drawer. The
 * three options are named for assistive technology and on hover.
 */
export function ColorSchemeSwitch({ className = 'flex' }: { className?: string }) {
  const { scheme, setScheme } = useColorScheme();
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={`${className} items-center gap-0.5 rounded-md border border-border p-0.5`}
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
            className={`flex h-8 w-8 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
              active
                ? 'bg-tint-primary text-action-primary'
                : 'text-text-muted hover:bg-background-subtle hover:text-text-primary'
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
