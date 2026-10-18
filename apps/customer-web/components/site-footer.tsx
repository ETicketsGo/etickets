'use client';

import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { BRAND_FOCUS, BrandStatusPill } from '@eticketsgo/web-kit';
import { INDIA_OPERATOR } from '@eticketsgo/shared-types';
import { Wordmark } from '@/components/wordmark';
import { LanguageSwitcher } from '@/components/language-switcher';
import { FeedbackButton } from '@/components/feedback-widget';

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
      /*
        About carries the company behind the brand and the legal and business information
        section. The marketing footer always linked it; this one, which the home page renders,
        did not, so a carrier reviewer starting at the front door could not reach it.
      */
      { href: '/about', label: 'about' },
      /*
        The way from the shop to the platform pages (N1). The shop's header carries the shop's
        navigation only, so without these the home page had no click that reached Features or
        the organizer pitch: the owner's own walk goes "Home -> Features -> Pricing".
      */
      { href: '/features', label: 'features' },
      { href: '/organizers', label: 'forOrganizers' },
      { href: '/terms', label: 'terms' },
      { href: '/privacy', label: 'privacy' },
      { href: '/refunds', label: 'refunds' },
      /*
        The text-message programme belongs in THIS footer, not only the marketing one.

        The home page takes the app chrome, so the marketing footer never renders on it - and a
        carrier reviewer starts at the home page with no inside knowledge. Linked only from the
        marketing footer, the page existed and was unreachable from the front door. A browser
        check caught it; the build and the route list both looked fine.

        Deliberately NOT added to `CHECKOUT_LINKS`: somebody at the payment step needs help and
        the documents they are agreeing to, and nothing else.
      */
      { href: '/sms', label: 'sms' },
      { href: '/legal', label: 'legal' },
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
  buildId = null,
}: {
  environmentNotice?: string | null;
  compact?: boolean;
  /** The short commit this server is running, so "which build is this?" has an answer. */
  buildId?: string | null;
}) {
  const f = useTranslations('common.footer');
  const g = useTranslations('storefront.guest');
  const h = useTranslations('home.footer');
  const nav = useTranslations('common.nav');

  const link = `inline-flex min-h-11 items-center rounded-sm text-brand-ui text-brand-ink-2 transition-colors hover:text-brand-ink lg:min-h-8 ${BRAND_FOCUS}`;

  return (
    /*
      The stage tone (DESIGN-SYSTEM.md section 1: the footer is one of the dark bands), so a page
      has a visual end instead of fading into grey. `mt-auto` with the shell's flex column pins
      it to the bottom of short pages.
    */
    <footer
      data-brand="customer"
      data-brand-tone="stage"
      className="mt-auto bg-brand-canvas font-brand-text text-brand-ink"
    >
      <div className="mx-auto max-w-shell px-4 py-12 sm:px-6 lg:px-10 lg:py-16">
        <div
          className={`grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_repeat(3,1fr)] ${
            compact ? 'max-lg:hidden' : ''
          }`}
        >
          <div>
            <Link
              href="/"
              aria-label={nav('home')}
              className={`inline-flex h-11 items-center rounded-brand-control ${BRAND_FOCUS}`}
            >
              <Wordmark className="text-[1.625rem]" />
            </Link>
            {/* Translated, not inlined: a hardcoded tagline passes a build that fails on
                missing keys and still shows English to a French reader. */}
            <p className="mt-3 max-w-xs text-brand-ui text-brand-ink-2">{f('tagline')}</p>
            {/*
              Language and feedback live here, on every page (EXPERIENCE-AUDIT.md C2 and C5).
              The language select spent the phone header's first row on the word "English";
              the feedback pill floated over content, prices included.
            */}
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
                  <li key={l.href}>
                    <Link href={l.href} className={link}>
                      {l.guest ? g(l.label) : f(`links.${l.label}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {compact && (
          <ul className="flex flex-wrap gap-x-6 lg:hidden">
            {CHECKOUT_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className={link}>
                  {f(`links.${l.label}`)}
                </Link>
              </li>
            ))}
          </ul>
        )}

        <div
          className={`flex flex-col items-start justify-between gap-3 border-t border-brand-line pt-6 text-brand-meta text-brand-ink-3 sm:flex-row sm:items-center ${
            compact ? 'mt-6 lg:mt-10' : 'mt-12'
          }`}
        >
          {/*
            The year is read at render rather than typed: a literal is wrong on 1 January.
            The company is the owner's wording for the footer - "DeepTrics Software Solutions
            Pvt Ltd" - read from the entity registry so it cannot drift from the legal pages.
          */}
          <p data-testid="footer-rights">
            {f('rights', { year: new Date().getFullYear(), entity: INDIA_OPERATOR.shortName })}
          </p>
          {buildId && (
            <p data-testid="build-id" className="tabular-nums">
              {f('build', { id: buildId })}
            </p>
          )}
          {environmentNotice && (
            <BrandStatusPill status="caution">{environmentNotice}</BrandStatusPill>
          )}
        </div>
      </div>
    </footer>
  );
}
