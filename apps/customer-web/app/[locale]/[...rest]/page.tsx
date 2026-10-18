import { notFound } from 'next/navigation';

/**
 * Every address under a locale that no route claims, sent to the locale's own 404.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────
 * Next answers an unmatched URL with the ROOT `app/not-found.tsx`, never with the
 * `[locale]/not-found.tsx` inside the layout: that one only renders when something inside the
 * locale calls `notFound()`. So `/no-such-page` drew a bare page with no header and no footer
 * (and no legal line) while `/events/no-such-event` drew the full shop. A catch-all is the
 * lowest-priority route there is - every real page still wins - and calling `notFound()` from
 * it hands the request to the 404 that lives inside the shell.
 */
export default function CatchAll() {
  notFound();
}
