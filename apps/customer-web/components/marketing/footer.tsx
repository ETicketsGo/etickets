import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Logo, needsPlaceholderNotice } from '@eticketsgo/web-kit';

const COLUMNS: { title: string; links: { href: string; label: string; external?: boolean }[] }[] = [
  {
    title: 'product',
    links: [
      { href: '/features', label: 'features' },
      { href: '/pricing', label: 'pricing' },
      { href: '/solutions', label: 'solutions' },
      { href: '/changelog', label: 'changelog' },
      { href: '/events', label: 'browseEvents' },
    ],
  },
  {
    title: 'audiences',
    links: [
      { href: '/organizers', label: 'forOrganizers' },
      { href: '/customers', label: 'forAttendees' },
      { href: '/register', label: 'getStarted' },
      { href: '/login', label: 'signIn' },
    ],
  },
  {
    title: 'resources',
    links: [
      { href: '/docs', label: 'documentation' },
      /*
        No Blog link, and no About link below, until either has real content.

        Both pages carry a banner saying their content is a placeholder, and the banner is
        true - the articles and the founder bios are samples. A launch footer that offers
        them presents sample writing as the company's own, and a visitor deciding whether to
        trust us with a card payment is exactly the wrong reader for that.

        Removing the link rather than the page: the routes still work for anyone who has one,
        and they stop being presented as finished launch content. Put the links back when
        there is something real behind them.
      */
      { href: '/faq', label: 'faq' },
      { href: '/contact', label: 'contact' },
    ],
  },
  {
    title: 'company',
    links: [
      /*
        These were English sentences used as translation KEYS — `links.Privacy`,
        `links.Organizer agreement`. No such keys existed, so this column rendered the raw
        key names to every visitor on the public site, and the five it broke were the legal
        links. camelCase now, matching every other column, and both locales have them.
      */
      { href: '/privacy', label: 'privacy' },
      { href: '/terms', label: 'terms' },
      { href: '/refunds', label: 'refunds' },
      { href: '/sms', label: 'sms' },
      { href: '/legal', label: 'legal' },
      { href: '/organizer-agreement', label: 'organizerAgreement' },
    ],
  },
];

export function MarketingFooter() {
  const f = useTranslations('common.footer');
  return (
    <footer className="border-t border-border bg-background-subtle/40">
      <div className="mx-auto max-w-shell px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <Link
              href="/"
              className="flex items-center gap-2 font-bold tracking-tight text-text-primary"
            >
              {/* Compact for the same reason as the storefront footer — see the note there. */}
              <Logo markClassName="h-9 w-9" id="mftr" />
            </Link>
            <p className="mt-3 max-w-xs text-[0.9375rem] leading-relaxed text-text-secondary">
              ETicketsGo sells your tickets, checks guests in at the door, and shows you how the
              event did. The gate keeps working when the network does not.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h3 className="text-caption font-semibold uppercase tracking-wide text-text-secondary">
                {f(`columns.${col.title}`)}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.href + l.label}>
                    <Link
                      href={l.href}
                      className="text-[0.9375rem] text-text-secondary transition-colors hover:text-text-primary"
                    >
                      {f(`links.${l.label}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col items-start justify-between gap-4 border-t border-border pt-6 text-caption text-text-secondary sm:flex-row sm:items-center">
          <p>© {2026} ETicketsGo. All rights reserved.</p>
          {/*
            Derived, not hardcoded. This notice used to be a constant, which meant it would
            still be here long after the details were real - and, worse, could be deleted while
            they were still fake. It now follows the details themselves and retires itself.
          */}
          {needsPlaceholderNotice() && (
            <p className="text-text-secondary">
              Our contact details and legal terms are not published yet.
            </p>
          )}
        </div>
      </div>
    </footer>
  );
}
