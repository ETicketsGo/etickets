'use client';

import { ColorSchemeSwitch as SharedColorSchemeSwitch } from '@eticketsgo/web-kit';

/**
 * Light, dark, or whatever the machine is doing - the same per-device preference, control and
 * storage key as the organizer console, now one shared component in web-kit. Icons only, to
 * stay small in the top bar (from `sm` up) and in the phone menu drawer; each option is named
 * for assistive technology and on hover.
 */
export function ColorSchemeSwitch({ className = 'flex' }: { className?: string }) {
  return <SharedColorSchemeSwitch className={className} />;
}
