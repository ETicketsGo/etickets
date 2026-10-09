'use client';

import Link from 'next/link';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { BadgeTone } from './components';

/*
  ── CONSOLE PRIMITIVES ──────────────────────────────────────────────────────────────
  The building blocks the organizer and admin consoles were each hand-rolling: a figure with
  a label, a titled section with its own action, a row of filters, a two-or-three-way switch
  and a fill bar. Each page had its own version, which is why the same idea looked four
  different ways across the consoles (see docs/ux/ORGANIZER-ADMIN-AUDIT.md).

  Built only from design tokens, so they follow the console accent, the storefront blue and
  an organization's own palette without knowing which one they are in. `MetricCard`,
  `Card`, `EmptyState`, `Skeleton`, `StatusBadge` and `Drawer` already existed and are not
  duplicated here.
*/

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const TONE_TEXT: Record<BadgeTone, string> = {
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
  info: 'text-status-info',
  neutral: 'text-text-primary',
};

const TONE_ICON: Record<BadgeTone, string> = {
  success: 'bg-tint-success text-status-success',
  warning: 'bg-tint-warning text-status-warning',
  error: 'bg-tint-error text-status-error',
  info: 'bg-tint-info text-status-info',
  neutral: 'bg-tint-primary text-action-primary',
};

/**
 * One figure, with what it is and what it is out of.
 *
 * The value is neutral by default. Colouring every number green or blue made the colour
 * mean nothing, so `tone` is for a figure that is genuinely a state - refunds outstanding,
 * capacity nearly gone - and the reason is always in the words as well, never colour alone.
 *
 * `href` makes the whole card a link to the page behind the number.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
  href,
  footer,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: BadgeTone;
  href?: string;
  footer?: ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.875rem] font-medium text-text-secondary">{label}</p>
        {Icon && (
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${TONE_ICON[tone]}`}
            aria-hidden
          >
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <p
        className={`mt-2 break-words text-[1.625rem] font-bold leading-tight tracking-tight tabular-nums ${TONE_TEXT[tone]}`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-caption text-text-muted">{hint}</p>}
      {footer && <div className="mt-3">{footer}</div>}
    </>
  );
  const frame = 'block rounded-lg border border-border bg-background-surface p-5 shadow-xs';
  return href ? (
    <Link
      href={href}
      className={`${frame} transition-shadow hover:shadow-md ${FOCUS} focus-visible:ring-offset-2`}
    >
      {body}
    </Link>
  ) : (
    <div className={frame}>{body}</div>
  );
}

/**
 * A titled section of a page, as a card.
 *
 * Unlike `Card`, it is a landmark-free <section> labelled by its own heading, so a screen
 * reader's heading list reads as the page's table of contents. `action` is the section's
 * one way onward - usually "View all" - and sits beside the title rather than at the bottom
 * where a long list would push it out of sight. `flush` drops the body padding for a list or
 * table that draws its own rows edge to edge.
 */
export function SectionCard({
  title,
  description,
  action,
  children,
  flush = false,
  className = '',
  headingLevel = 2,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  const id = useId();
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section
      aria-labelledby={id}
      className={`min-w-0 rounded-lg border border-border bg-background-surface shadow-xs ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pb-3 pt-5">
        <div className="min-w-0">
          <Heading id={id} className="text-[1.0625rem] font-semibold text-text-primary">
            {title}
          </Heading>
          {description && <p className="mt-0.5 text-caption text-text-muted">{description}</p>}
        </div>
        {action}
      </div>
      <div className={flush ? 'pb-2' : 'px-5 pb-5'}>{children}</div>
    </section>
  );
}

/** "View all ->", the usual `SectionCard` action. Names its destination for screen readers. */
export function SectionLink({
  href,
  children,
  srLabel,
}: {
  href: string;
  children: ReactNode;
  /** Appended for assistive technology, so five "View all" links are not indistinguishable. */
  srLabel?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1 rounded-sm text-caption font-semibold text-action-primary hover:underline ${FOCUS}`}
    >
      {children}
      {srLabel && <span className="sr-only"> {srLabel}</span>}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}

/**
 * The row of search, filters and actions above a list.
 *
 * Filters on the left, actions on the right, and it wraps rather than overflowing: on a
 * phone the actions drop under the filters instead of pushing the page sideways.
 */
export function Toolbar({
  label,
  children,
  actions,
}: {
  /** What the controls act on, for assistive technology - "Filter events". */
  label: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background-surface p-3"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The same row, by the name a list page reaches for. */
export const FilterBar = Toolbar;

/**
 * Two to five mutually exclusive choices that switch what a view shows.
 *
 * A radio group, because that is what it is: one choice, always one made. Arrow keys are
 * the browser's own radio behaviour only for native inputs, so the buttons here are each a
 * tab stop - fewer keystrokes to learn than a roving tabindex for a three-item control.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex max-w-full flex-wrap gap-1 rounded-md border border-border bg-background-subtle p-1"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`rounded-sm px-3 py-1.5 text-caption font-medium transition-colors ${FOCUS} ${
              on
                ? 'bg-background-surface text-text-primary shadow-xs'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * How full something is - capacity sold, tickets checked in.
 *
 * `role="meter"` with the numbers, so the bar is not the only place the figure exists. The
 * fill is clamped: a sold count above capacity (comps, a capacity lowered after sale) must
 * not draw past the end of the track.
 */
export function Meter({
  value,
  max,
  label,
  tone = 'neutral',
}: {
  value: number;
  max: number;
  label: string;
  tone?: BadgeTone;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const fill: Record<BadgeTone, string> = {
    success: 'bg-status-success',
    warning: 'bg-status-warning',
    error: 'bg-status-error',
    info: 'bg-status-info',
    neutral: 'bg-action-primary',
  };
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(max, 1)}
      aria-valuenow={Math.min(value, max)}
      className="h-2 w-full overflow-hidden rounded-full bg-background-subtle"
    >
      <div className={`h-full rounded-full ${fill[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
