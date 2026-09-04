import { Ticket } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

/**
 * The end of a storefront page.
 *
 * ── WHAT WAS HERE ──────────────────────────────────────────────────────────────────
 * One centred line of grey text reading "ETicketsGo — demo MVP. Mock payments only."
 * That is three separate problems in eleven words. It told every customer on a live
 * environment that the payments were fake; it gave a page no visual end, so a short listing
 * left a wide band of empty grey between the last card and the bottom of the window; and it
 * offered nothing a person at the bottom of a page actually wants — where their tickets
 * are, how to get help, what the refund policy says.
 *
 * ── WHY IT IS NOT THE MARKETING FOOTER ─────────────────────────────────────────────
 * There is a good four-column footer already, and it is aimed at somebody deciding whether
 * to *use* the platform: pricing, solutions, changelog, "for organizers". Somebody who has
 * already opened a ticket page is past that. This one answers the questions of a person
 * mid-purchase, and it is deliberately shorter — a footer that repeats a sales menu under a
 * checkout is noise at the exact moment attention matters most.
 *
 * ── THE ENVIRONMENT NOTICE ─────────────────────────────────────────────────────────
 * The "demo" line is not deleted, it is made true. On QA and UAT it still says so, because
 * it IS a test environment and a tester needs to know. In production it says nothing,
 * because there it would be false. Keyed on APP_ENV rather than NODE_ENV: QA and UAT both
 * run NODE_ENV=production, and a guard keyed on that would have hidden the notice exactly
 * where it is wanted and shown it exactly where it is not.
 */

/** Where a person mid-purchase actually wants to go from the bottom of a page. */
const COLUMNS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: 'product',
    links: [
      { href: '/events', label: 'browseEvents' },
      { href: '/movies', label: 'browseMovies' },
      { href: '/account/tickets', label: 'myTickets' },
    ],
  },
  {
    title: 'resources',
    links: [
      { href: '/help', label: 'help' },
      { href: '/faq', label: 'faq' },
      { href: '/contact', label: 'contact' },
    ],
  },
  {
    title: 'company',
    links: [
      { href: '/terms', label: 'terms' },
      { href: '/privacy', label: 'privacy' },
      { href: '/refunds', label: 'refunds' },
    ],
  },
];

export function SiteFooter({ environmentNotice }: { environmentNotice?: string | null }) {
  const f = useTranslations('common.footer');

  return (
    /*
      `mt-auto` with the shell's flex column pins this to the bottom of short pages, so a
      listing with two results does not leave the footer floating halfway up the window.
    */
    <footer className="mt-auto border-t border-border bg-background-subtle/50">
      <div className="mx-auto max-w-shell px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_repeat(3,1fr)]">
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-2 font-bold tracking-tight text-text-primary"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-action-primary text-action-primary-foreground shadow-sm">
                <Ticket className="h-4 w-4" />
              </span>
              <span className="text-[1.05rem]">
                ETickets<span className="text-action-primary">Go</span>
              </span>
            </Link>
            {/* Translated, not inlined. The marketing footer's tagline is a hardcoded
                English string, which is how a page passes a build that fails on missing
                keys and still shows English to a French reader. */}
            <p className="mt-3 max-w-xs text-[0.9375rem] leading-relaxed text-text-secondary">
              {f('tagline')}
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h2 className="text-caption font-semibold uppercase tracking-wide text-text-secondary">
                {f(`columns.${col.title}`)}
              </h2>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="rounded-sm text-[0.9375rem] text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {f(`links.${l.label}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-border pt-6 text-caption text-text-muted sm:flex-row sm:items-center">
          {/* The year is read at render rather than typed. A literal `2026` in the markup
              is wrong on the first of January and nobody is watching the footer then. */}
          <p>{f('rights', { year: new Date().getFullYear() })}</p>
          {environmentNotice && (
            <p className="rounded-md bg-status-warning/10 px-2.5 py-1 font-medium text-status-warning">
              {environmentNotice}
            </p>
          )}
        </div>
      </div>
    </footer>
  );
}
