'use client';

import { useCallback, useEffect, useState } from 'react';
import { ACCENT_THEMES, isAccentTheme, type AccentTheme } from '@eticketsgo/design-tokens';

/**
 * Two preferences that look alike and belong to different people.
 *
 * ── THE SPLIT ──────────────────────────────────────────────────────────────────────
 * The ACCENT is the organization's. It is a brand, and a brand each team member chose
 * separately is not one — the box office, the manager and the owner should be looking at the
 * same workspace, the way they would if the console were their own site. So it lives on the
 * Organization, an owner or manager sets it, and everyone in that organization gets it.
 *
 * LIGHT OR DARK is the person's. It is about their eyes and the room they are sitting in, and
 * an organization imposing dark mode on a box office under fluorescent lights would be an
 * organization deciding something that is not theirs to decide. So it is per-device, stored
 * locally, and defaults to following the operating system.
 *
 * Conflating the two is the usual mistake, and it produces either a brand nobody shares or a
 * personal setting somebody else controls.
 */

export const COLOR_SCHEMES = ['system', 'light', 'dark'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

const SCHEME_KEY = 'etg_color_scheme';
/**
 * The last accent we rendered, remembered per device.
 *
 * The accent comes from the API, so on a cold load it is not known until a request completes
 * — and a workspace that paints itself blue for half a second and then turns violet looks
 * broken rather than branded. Caching the last one lets the very first paint be right for the
 * overwhelmingly common case of somebody returning to their own workspace, and the value from
 * the API still wins the moment it arrives.
 */
const ACCENT_CACHE_KEY = 'etg_workspace_accent';

/** localStorage, which throws in a private window and is absent on the server. */
function readStored(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* a preference that cannot be saved is not worth failing a page over */
  }
}

/**
 * A blocking script for the document head, so the first paint is already correct.
 *
 * ── WHY A STRING OF JAVASCRIPT ─────────────────────────────────────────────────────
 * React applies this in an effect, which runs after the first paint. Somebody who has chosen
 * dark mode would see a white page flash on every navigation — a small thing that makes an
 * application feel like a web page rather than a product. The only fix is to set the
 * attributes before the browser paints, which means a synchronous script.
 *
 * It reads two keys and sets two attributes. It touches nothing else, and every access is
 * wrapped, because a private window that throws on localStorage must still render a page.
 */
export const workspaceThemeScript = `(function(){try{
var d=document.documentElement;
var s=localStorage.getItem('${SCHEME_KEY}')||'system';
var dark=s==='dark'||(s==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
d.classList.toggle('dark',dark);
var a=localStorage.getItem('${ACCENT_CACHE_KEY}');
if(a&&a!=='default'){d.setAttribute('data-accent',a);}
}catch(e){}})();`;

/**
 * Paint the workspace in the organization's accent.
 *
 * Renders nothing. `accent` is whatever the API returned, which may be null (never chosen),
 * 'default' (chose the platform blue), or a palette this build no longer ships — the last of
 * which falls back to the default rather than leaving a stale attribute that matches nothing.
 */
export function WorkspaceAccent({ accent }: { accent: string | null | undefined }): null {
  useEffect(() => {
    const key = isAccentTheme(accent) ? accent : 'default';
    const root = document.documentElement;
    if (key === 'default') root.removeAttribute('data-accent');
    else root.setAttribute('data-accent', key);
    writeStored(ACCENT_CACHE_KEY, key);
  }, [accent]);
  return null;
}

/**
 * The person's light/dark choice, and the switch that changes it.
 *
 * 'system' is the default and it KEEPS FOLLOWING the system: the media query is watched, so
 * somebody whose laptop dims at sunset gets a console that dims with it rather than one that
 * decided at page load.
 */
export function useColorScheme(): {
  scheme: ColorScheme;
  resolved: 'light' | 'dark';
  setScheme: (next: ColorScheme) => void;
} {
  const [scheme, setSchemeState] = useState<ColorScheme>('system');
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const stored = readStored(SCHEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') setSchemeState(stored);

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: 'light' | 'dark' = scheme === 'system' ? (systemDark ? 'dark' : 'light') : scheme;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setScheme = useCallback((next: ColorScheme) => {
    setSchemeState(next);
    writeStored(SCHEME_KEY, next);
  }, []);

  return { scheme, resolved, setScheme };
}

/** The palettes an organization may choose, for rendering a picker. */
export { ACCENT_THEMES };
export type { AccentTheme };
