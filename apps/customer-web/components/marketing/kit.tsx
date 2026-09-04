import type { LucideIcon } from 'lucide-react';
import { Link } from '@/i18n/navigation';

/** Wide, responsive content container for marketing pages. */
export function Container({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-shell px-4 sm:px-6 lg:px-8 ${className}`}>{children}</div>
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
  return (
    <section id={id} className={`py-16 sm:py-24 ${className}`}>
      {children}
    </section>
  );
}

/**
 * Small uppercase accent label above a heading.
 *
 * `bg-tint-primary` is opaque on purpose. As a 10% wash this measured 4.83:1 on a white card
 * and 3.78:1 on the tinted hero sections these headings actually sit in — a single component
 * failing WCAG AA on nineteen storefront pages, because its contrast depended on a background
 * chosen somewhere else entirely.
 */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-action-primary/20 bg-tint-primary px-3 py-1 text-caption font-semibold uppercase tracking-wide text-action-primary">
      {children}
    </span>
  );
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
      <h2 className="mt-4 text-balance text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
        {title}
      </h2>
      {lead && (
        <p className="mt-4 text-pretty text-lg leading-relaxed text-text-secondary">{lead}</p>
      )}
    </div>
  );
}

/** A soft, decorative gradient blob for hero/CTA backdrops (purely aesthetic). */
export function GradientBackdrop({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 -z-10 overflow-hidden ${className}`}
    >
      <div className="absolute left-1/2 top-[-10%] h-[40rem] w-[60rem] -translate-x-1/2 rounded-full bg-action-primary/15 blur-[120px]" />
      <div className="absolute right-[-10%] top-[20%] h-[30rem] w-[30rem] rounded-full bg-status-info/10 blur-[120px]" />
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
    <div className="group rounded-2xl border border-border bg-background-surface p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-action-primary/30 hover:shadow-md">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-tint-primary text-action-primary transition-colors group-hover:bg-action-primary group-hover:text-action-primary-foreground">
        <Icon className="h-5 w-5" />
      </span>
      <h3 className="mt-4 text-base font-semibold text-text-primary">{title}</h3>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-text-secondary">{children}</p>
    </div>
  );
}

/** A single headline statistic. */
export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">{value}</div>
      <div className="mt-1 text-caption font-medium uppercase tracking-wide text-text-muted">
        {label}
      </div>
    </div>
  );
}

/** Full-width call-to-action band with a gradient surface. */
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
      <div className="relative overflow-hidden rounded-3xl border border-action-primary/20 bg-gradient-to-br from-action-primary/10 via-background-surface to-status-info/10 px-6 py-14 text-center shadow-sm sm:px-16">
        <GradientBackdrop />
        <h2 className="text-balance text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
          {title}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-text-secondary">{lead}</p>
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
    <Link
      href={href}
      className={`inline-flex items-center justify-center gap-2 rounded-xl bg-action-primary px-5 py-3 text-[0.9375rem] font-semibold text-action-primary-foreground shadow-sm transition-all duration-200 hover:bg-action-primary-hover hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas ${className}`}
    >
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
    <Link
      href={href}
      className={`inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background-surface px-5 py-3 text-[0.9375rem] font-semibold text-text-primary shadow-xs transition-all duration-200 hover:border-border-strong hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas ${className}`}
    >
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
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-tint-success text-status-success"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 10.7a1 1 0 1 1 1.4-1.4l3.1 3.1 6.8-6.8a1 1 0 0 1 1.4 0Z"
            clipRule="evenodd"
          />
        </svg>
      </span>
      <span className="text-[0.9375rem] leading-relaxed text-text-secondary">{children}</span>
    </li>
  );
}
