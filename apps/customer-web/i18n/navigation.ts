import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

/**
 * Locale-aware replacements for `next/link` and `next/navigation`.
 *
 * ── WHY EVERY INTERNAL LINK HAS TO COME FROM HERE ──────────────────────────────────
 * `<Link href="/pricing">` from `next/link` renders exactly that path. On a French page that
 * navigates to the ENGLISH pricing page and silently drops the locale — the reader is put
 * back into English by clicking a link, with nothing to tell them why or how to get back.
 * One such link anywhere in the shared chrome undoes the whole feature.
 *
 * These wrappers prefix the current locale automatically, so `href` stays written the way it
 * always was and the locale is never something a call site has to remember.
 *
 * `redirect` and `usePathname` are here for the same reason: a redirect that forgets the
 * locale sends somebody from a French checkout to an English confirmation, which is the one
 * page they are guaranteed to read carefully.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
