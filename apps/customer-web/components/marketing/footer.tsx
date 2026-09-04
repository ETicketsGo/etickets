import { Ticket } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

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
      { href: '/blog', label: 'blog' },
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
      { href: '/about', label: 'about' },
      { href: '/privacy', label: 'privacy' },
      { href: '/terms', label: 'terms' },
      { href: '/refunds', label: 'refunds' },
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
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-action-primary text-action-primary-foreground shadow-sm">
                <Ticket className="h-4 w-4" />
              </span>
              <span className="text-[1.05rem]">
                ETickets<span className="text-action-primary">Go</span>
              </span>
            </Link>
            <p className="mt-3 max-w-xs text-[0.9375rem] leading-relaxed text-text-secondary">
              The experience-commerce platform for selling tickets, checking in guests, and
              understanding your events — online and offline.
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
          <p className="text-text-secondary">
            Demo build · contact details &amp; legal terms are placeholders pending finalization.
          </p>
        </div>
      </div>
    </footer>
  );
}
