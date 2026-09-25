import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Logo } from '@eticketsgo/web-kit';

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

/**
 * Where a person mid-purchase actually wants to go from the bottom of a page.
 *
 * `guest: true` means the label lives in the storefront catalogue rather than the shared footer
 * one. "Find my booking" is the guest flow's own wording, and it belongs beside that flow's
 * other copy so the two are translated and reviewed together.
 */
const COLUMNS: {
  title: string;
  links: { href: string; label: string; guest?: boolean }[];
}[] = [
  {
    title: 'product',
    links: [
      { href: '/events', label: 'browseEvents' },
      { href: '/movies', label: 'browseMovies' },
      { href: '/account/tickets', label: 'myTickets' },
      /*
        For somebody who bought without an account. "My tickets" above it needs a sign-in, so
        without this line the footer offered a guest nothing at all.
      */
      { href: '/booking/find', label: 'findTitle', guest: true },
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

/**
 * The links a person at the payment step still needs.
 *
 * Deliberately not "the important ones from each column". Somebody about to pay needs help if
 * something has gone wrong, and the three documents that say what they are agreeing to. Anything
 * that sends them shopping again is what the compact footer exists to remove.
 */
const CHECKOUT_LINKS: { href: string; label: string }[] = [
  { href: '/help', label: 'help' },
  { href: '/terms', label: 'terms' },
  { href: '/privacy', label: 'privacy' },
  { href: '/refunds', label: 'refunds' },
];

export function SiteFooter({
  environmentNotice,
  /**
   * Drop the link columns ON A PHONE, keeping help and the legal documents.
   *
   * Desktop is untouched at any value: the columns are hidden with `max-lg:hidden` and the one-line
   * replacement with `lg:hidden`, so from `lg` up this renders exactly what it always did. That is
   * the owner's standing instruction for this round of work - fix the phone, do not move the web -
   * and it is asserted in `mobile-storefront.spec.ts` rather than left as an intention.
   */
  compact = false,
}: {
  environmentNotice?: string | null;
  compact?: boolean;
}) {
  const f = useTranslations('common.footer');
  const g = useTranslations('storefront.guest');

  return (
    /*
      `mt-auto` with the shell's flex column pins this to the bottom of short pages, so a
      listing with two results does not leave the footer floating halfway up the window.
    */
    <footer className="mt-auto border-t border-border bg-background-subtle/50">
      <div className="mx-auto max-w-shell px-4 py-12 sm:px-6 lg:px-8">
        <div
          className={`grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_repeat(3,1fr)] ${
            compact ? 'max-lg:hidden' : ''
          }`}
        >
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-2 font-bold tracking-tight text-text-primary"
            >
              {/* Compact, not full. A footer lockup is ~36px and the full mark's streaks
                  and tear line are two pixels each at that size — they render as a smudge
                  beside the wordmark rather than as motion. The full mark earns its detail
                  above roughly 40px; below it, the ticket and the E carry the brand alone. */}
              <Logo markClassName="h-9 w-9" id="ftr" />
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
                      {l.guest ? g(l.label) : f(`links.${l.label}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {compact && (
          <ul className="flex flex-wrap gap-x-6 gap-y-3 lg:hidden">
            {CHECKOUT_LINKS.map((l) => (
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
        )}

        <div
          className={`flex flex-col items-start justify-between gap-3 border-t border-border pt-6 text-caption text-text-muted sm:flex-row sm:items-center ${
            compact ? 'mt-6 lg:mt-10' : 'mt-10'
          }`}
        >
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
