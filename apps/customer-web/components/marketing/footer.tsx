import { Ticket } from 'lucide-react';
import { Link } from '@/i18n/navigation';

const COLUMNS: { title: string; links: { href: string; label: string; external?: boolean }[] }[] = [
  {
    title: 'Product',
    links: [
      { href: '/features', label: 'Features' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/solutions', label: 'Solutions' },
      { href: '/changelog', label: 'Changelog' },
      { href: '/events', label: 'Browse events' },
    ],
  },
  {
    title: 'Audiences',
    links: [
      { href: '/organizers', label: 'For organizers' },
      { href: '/customers', label: 'For attendees' },
      { href: '/register', label: 'Get started' },
      { href: '/login', label: 'Sign in' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { href: '/docs', label: 'Documentation' },
      { href: '/blog', label: 'Blog' },
      { href: '/faq', label: 'FAQ' },
      { href: '/contact', label: 'Contact' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/about', label: 'About' },
      { href: '/privacy', label: 'Privacy' },
      { href: '/terms', label: 'Terms' },
      { href: '/refunds', label: 'Refunds' },
      { href: '/organizer-agreement', label: 'Organizer agreement' },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-border bg-background-subtle/40">
      <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8">
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
                {col.title}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.href + l.label}>
                    <Link
                      href={l.href}
                      className="text-[0.9375rem] text-text-secondary transition-colors hover:text-text-primary"
                    >
                      {l.label}
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
