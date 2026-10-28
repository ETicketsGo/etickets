'use client';

import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import {
  BRAND_FOCUS,
  BrandStatusPill,
  needsPlaceholderNotice,
  Wordmark,
} from '@eticketsgo/web-kit';
import { FooterLegalLines } from '@/components/legal/operator-statement';
import { FooterSignInLink } from '@/components/marketing/footer-sign-in-link';
import { LanguageSwitcher } from '@/components/language-switcher';
import { FeedbackButton } from '@/components/feedback-widget';

/*
  ── THE MARKETING FOOTER, DRAWN AS THE STOREFRONT FOOTER ───────────────────────────────────
  Same stage band, wordmark, type, language switcher and feedback button as `SiteFooter`, which
  the home page and Explore end with, so About or the terms no longer end in a second product's
  grey footer. What it keeps of its own is what it was for: the four columns of links to the
  platform pages (features, pricing, the organizer agreement and the rest), the sign-in link
  that returns to this page, and the placeholder notice.

  The language switcher moved here from the old marketing header. Neither the storefront header
  nor the marketing header has one (it lives in the footer, EXPERIENCE-AUDIT.md C2), and
  without it a French reader of the terms had no way to French.
*/

const FOOTER_LINK = `inline-flex min-h-11 items-center rounded-sm text-brand-ui text-brand-ink-2 transition-colors hover:text-brand-gold-text lg:min-h-8 ${BRAND_FOCUS}`;

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
      { href: '/sms', label: 'sms' },
      { href: '/legal', label: 'legal' },
      { href: '/organizer-agreement', label: 'organizerAgreement' },
    ],
  },
];

export function MarketingFooter({
  buildId = null,
  environmentNotice = null,
  initialSignedIn = false,
}: {
  buildId?: string | null;
  environmentNotice?: string | null;
  /** The server's session hint, so a signed-in reader is not offered "Sign in" (N1). */
  initialSignedIn?: boolean;
}) {
  const f = useTranslations('common.footer');
  const h = useTranslations('home.footer');
  // The wordmark link's name contains the words it shows ("ETicketsGo home"), as the header's does.
  const hd = useTranslations('home.header');
  return (
    <footer
      data-brand="customer"
      data-brand-tone="stage"
      className="mt-auto bg-brand-canvas font-brand-text text-brand-ink"
    >
      <div className="mx-auto max-w-shell px-4 py-12 sm:px-6 lg:px-10 lg:py-16">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div className="col-span-2 lg:col-span-1">
            <Link
              href="/"
              aria-label={hd('homeLabel')}
              className={`inline-flex h-11 items-center rounded-brand-control ${BRAND_FOCUS}`}
            >
              <Wordmark size="lg" tone="brand" />
            </Link>
            <p className="mt-3 max-w-xs text-brand-ui text-brand-ink-2">
              ETicketsGo sells your tickets, checks guests in at the door, and shows you how the
              event did. The gate keeps working when the network does not.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <LanguageSwitcher />
              <FeedbackButton
                label={h('feedback')}
                className={`inline-flex h-11 items-center gap-2 rounded-brand-control border border-brand-line-strong px-4 text-brand-ui font-semibold text-brand-ink transition-colors hover:border-brand-ink-3 ${BRAND_FOCUS}`}
              />
            </div>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h2 className="text-brand-eyebrow uppercase text-brand-ink-3">
                {f(`columns.${col.title}`)}
              </h2>
              <ul className="mt-4 lg:space-y-1">
                {col.links.map((l) => (
                  <li key={l.href + l.label}>
                    {l.href === '/login' ? (
                      <FooterSignInLink
                        className={FOOTER_LINK}
                        initialSignedIn={initialSignedIn}
                        signInLabel={f(`links.${l.label}`)}
                        signedInLabel={f('links.myTickets')}
                      />
                    ) : (
                      <Link href={l.href} className={FOOTER_LINK}>
                        {f(`links.${l.label}`)}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-brand-line pt-6 text-brand-meta text-brand-ink-3 sm:flex-row sm:items-center">
          {/*
            The same line, from the same catalogue key, as the storefront footer. This one used
            to be a hardcoded English literal, so the two footers already disagreed and a French
            reader got English here.
          */}
          <FooterLegalLines />
          {/*
            Derived, not hardcoded. This notice used to be a constant, which meant it would
            still be here long after the details were real - and, worse, could be deleted while
            they were still fake. It now follows the details themselves and retires itself.
          */}
          {buildId && (
            <p data-testid="build-id" className="tabular-nums">
              {f('build', { id: buildId })}
            </p>
          )}
          {needsPlaceholderNotice() && (
            <p>Our contact details and legal terms are not published yet.</p>
          )}
          {environmentNotice && (
            <BrandStatusPill status="caution">{environmentNotice}</BrandStatusPill>
          )}
        </div>
      </div>
    </footer>
  );
}
