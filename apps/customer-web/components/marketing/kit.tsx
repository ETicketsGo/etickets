import type { LucideIcon } from 'lucide-react';
import { Link } from '@/i18n/navigation';

/*
  ── THE MARKETING PAGES ON THE BRAND LAYER (docs/design/DESIGN-SYSTEM.md) ──────────────────
  About, the legal pages, pricing, the organizer pitch and the rest were the last storefront
  pages drawn in the old system: a blue header with "Go to app", blue buttons, pastel gradient
  washes and a shadow on every card. A visitor who clicked "Terms" in the home page's footer
  crossed into a second product. These pieces now draw with the `brand-*` tokens, so every page
  built from them moved at once. Every page also sits inside `BrandPage`, which supplies the
  `data-brand` scope these colours need.

  The blurred blue and cyan "GradientBackdrop" circles are gone rather than recoloured: the
  brand layer's contrast is paper against the stage band, not a wash behind the text.

  ── WHY THE CLASS STRINGS ARE SPELLED OUT HERE ──────────────────────────────────────────────
  `BRAND_FOCUS` and `brandButtonClasses` live in web-kit's `brand.tsx`, a 'use client' module.
  Most of these pages are server components, and a server component that CALLS a function from
  a client module gets a client reference, not a string. So the same classes are written out
  here; they are pinned against the preset by `storefront-brand-pages.test.ts`.
*/

/** One focus treatment, the same ring as web-kit's `BRAND_FOCUS`. */
export const MK_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas';

const MK_BUTTON = `inline-flex min-h-11 items-center justify-center gap-2 rounded-brand-control px-5 py-2.5 text-center font-brand-text text-brand-ui font-semibold transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 ${MK_FOCUS}`;

/** Ink on paper (marigold on a stage band): the page's one main action. */
export const MK_PRIMARY = `${MK_BUTTON} bg-brand-action text-brand-on-action hover:bg-brand-action-hover`;

/** A hairline button for the second choice beside a primary one. */
export const MK_SECONDARY = `${MK_BUTTON} border border-brand-line-strong bg-brand-surface text-brand-ink hover:border-brand-ink-3`;

/** An inline text link in running copy: ink, underlined, so it never depends on colour alone. */
export const MK_LINK = `rounded-sm font-medium text-brand-ink underline decoration-brand-line-strong underline-offset-4 hover:decoration-brand-ink ${MK_FOCUS}`;

/** A white card with a hairline, no shadow: the brand's panel. */
export const MK_PANEL = 'rounded-brand-card border border-brand-line bg-brand-surface';

/** A form field on paper, matching the booking flow's `BRAND_FIELD`. */
export const MK_FIELD = `w-full rounded-brand-control border border-brand-field bg-brand-surface px-3 py-2.5 text-brand-ui text-brand-ink placeholder:text-brand-ink-3 ${MK_FOCUS}`;

/** The small uppercase label over a heading or a column. */
export const MK_EYEBROW = 'text-brand-eyebrow uppercase text-brand-ink-3';

/** An icon in a quiet square, for a feature or a contact row. */
export const MK_ICON_TILE =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-brand-control bg-brand-sunken text-brand-ink';

/** Wide, responsive content container, with the same gutters as the header. */
export function Container({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-shell px-4 sm:px-6 lg:px-10 ${className}`}>
      {children}
    </div>
  );
}

/** Vertical rhythm wrapper for a page section. */
export function Section({
  children,
  className = '',
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  // 64px of air above and below every section is a desktop rhythm on a phone.
  return (
    <section id={id} className={`py-10 sm:py-20 ${className}`}>
      {children}
    </section>
  );
}

/**
 * Small uppercase label above a heading.
 *
 * It used to be a tinted pill whose contrast depended on the backdrop behind it (it failed AA
 * on the gradient heroes). On paper it is plain secondary ink, as on Explore and the home page.
 */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className={MK_EYEBROW}>{children}</span>;
}

/** Centered (or left) section heading with optional eyebrow + lead paragraph. */
export function SectionHeading({
  eyebrow,
  title,
  lead,
  align = 'center',
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  lead?: React.ReactNode;
  align?: 'center' | 'left';
}) {
  const a = align === 'center' ? 'mx-auto text-center' : 'text-left';
  return (
    <div className={`max-w-2xl ${a}`}>
      {eyebrow && (
        <div className={align === 'center' ? 'flex justify-center' : ''}>
          {<Eyebrow>{eyebrow}</Eyebrow>}
        </div>
      )}
      <h2 className="mt-3 text-balance font-brand-display text-brand-d2 text-brand-ink">{title}</h2>
      {lead && <p className="mt-4 text-pretty text-brand-lead text-brand-ink-2">{lead}</p>}
    </div>
  );
}

/** Feature card: icon tile, title, description. */
export function FeatureCard({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`${MK_PANEL} p-6`}>
      <span className={MK_ICON_TILE}>
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <h3 className="mt-4 font-brand-display text-brand-card text-brand-ink">{title}</h3>
      <p className="mt-2 text-brand-ui text-brand-ink-2">{children}</p>
    </div>
  );
}

/** A single headline statistic. */
export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="font-brand-display text-brand-d3 text-brand-ink">{value}</div>
      <div className={`mt-1 ${MK_EYEBROW}`}>{label}</div>
    </div>
  );
}

/**
 * Full-width call-to-action band on the stage tone, like the home page's "Now showing" band.
 *
 * On a stage the action colour swaps to the marigold light (brand.css), so the same
 * `MK_PRIMARY` class reads correctly on it without a second variant.
 */
export function CtaBand({
  title,
  lead,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
}: {
  title: string;
  lead: string;
  primaryHref: string;
  primaryLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <Container>
      <div
        data-brand-tone="stage"
        className="rounded-brand-card bg-brand-canvas px-6 py-10 text-center sm:px-16 sm:py-14"
      >
        <h2 className="text-balance font-brand-display text-brand-d2 text-brand-ink">{title}</h2>
        <p className="mx-auto mt-4 max-w-xl text-brand-lead text-brand-ink-2">{lead}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <PrimaryLink href={primaryHref}>{primaryLabel}</PrimaryLink>
          {secondaryHref && secondaryLabel && (
            <SecondaryLink href={secondaryHref}>{secondaryLabel}</SecondaryLink>
          )}
        </div>
      </div>
    </Container>
  );
}

/** Primary CTA link styled as a solid button (works in server components). */
export function PrimaryLink({
  href,
  children,
  className = '',
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className={`${MK_PRIMARY} ${className}`}>
      {children}
    </Link>
  );
}

/** Secondary CTA link styled as an outline button. */
export function SecondaryLink({
  href,
  children,
  className = '',
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className={`${MK_SECONDARY} ${className}`}>
      {children}
    </Link>
  );
}

/** A labelled checklist row used across benefit sections. */
export function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-positive-tint text-brand-positive"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 10.7a1 1 0 1 1 1.4-1.4l3.1 3.1 6.8-6.8a1 1 0 0 1 1.4 0Z"
            clipRule="evenodd"
          />
        </svg>
      </span>
      <span className="text-brand-ui text-brand-ink-2">{children}</span>
    </li>
  );
}
