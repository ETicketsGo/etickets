'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { BRAND_FOCUS, type BrandStatus } from '@eticketsgo/web-kit';

/*
  ── THE ADMIN DESK'S PIECES (PROPOSAL) ─────────────────────────────────────────────
  docs/design/ADMIN-PROPOSAL.md. Brand tokens only: paper and ink, hairlines, numbers in Inter
  tabular, the display face for the page title only, marigold for "where you are" and nothing
  else. Status colour only for a state (critical, caution, positive, info), always with words.
*/

export const LINK = `inline-flex min-h-6 items-center rounded-sm font-semibold text-brand-ink underline underline-offset-4 decoration-brand-line-strong hover:decoration-brand-ink ${BRAND_FOCUS}`;

/** Says the screen is a proposal, so a screenshot of it cannot be mistaken for the live console. */
export function ProposalNote() {
  return (
    <p className="rounded-brand-control border border-dashed border-brand-line-strong bg-brand-sunken px-3 py-2 text-brand-meta text-brand-ink-2">
      Proposal prototype. Live data, read-only layout study. The current console is at{' '}
      <Link href="/admin" className={LINK}>
        /admin
      </Link>
      .
    </p>
  );
}

/** "As of 11:42" plus a refresh. Every screen says when its numbers were read. */
export function AsOf({
  at,
  onRefresh,
  busy,
}: {
  at: number | null;
  onRefresh?: () => void;
  busy?: boolean;
}) {
  const time = at
    ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <span className="inline-flex items-center gap-2 text-brand-meta text-brand-ink-3">
      <span aria-live="polite">
        {busy ? 'Reading...' : time ? `As of ${time}, your time` : 'Not read yet'}
      </span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-brand-control text-brand-ink-2 hover:bg-brand-sunken hover:text-brand-ink ${BRAND_FOCUS}`}
          aria-label="Read again"
        >
          <RefreshCw
            className={`h-4 w-4 ${busy ? 'animate-spin motion-reduce:animate-none' : ''}`}
            aria-hidden
          />
        </button>
      )}
    </span>
  );
}

export function PageHead({
  eyebrow,
  title,
  description,
  meta,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-brand-eyebrow uppercase text-brand-ink-3">{eyebrow}</p>
        <h1 className="mt-1 font-brand-display text-brand-page text-brand-ink">{title}</h1>
        {description && (
          <p className="mt-1 max-w-prose text-brand-ui text-brand-ink-2">{description}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {meta}
        {action}
      </div>
    </header>
  );
}

export function Panel({
  title,
  meta,
  action,
  children,
  flush = false,
  id,
}: {
  title: string;
  /** What the panel counts, its window and currency, in one line. */
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  id?: string;
}) {
  const headingId = id ? `${id}-h` : undefined;
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 rounded-brand-card border border-brand-line bg-brand-surface"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 pt-4 sm:px-6">
        <div className="min-w-0">
          <h2 id={headingId} className="text-brand-body font-semibold text-brand-ink">
            {title}
          </h2>
          {meta && <p className="text-brand-meta text-brand-ink-3">{meta}</p>}
        </div>
        {action}
      </div>
      <div className={flush ? 'mt-3' : 'px-4 pb-4 pt-3 sm:px-6 sm:pb-6'}>{children}</div>
    </section>
  );
}

const STATE: Record<BrandStatus, string> = {
  positive: 'bg-brand-positive-tint text-brand-positive',
  caution: 'bg-brand-caution-tint text-brand-caution',
  critical: 'bg-brand-critical-tint text-brand-critical',
  info: 'bg-brand-info-tint text-brand-info',
  neutral: 'bg-brand-sunken text-brand-ink-2',
  live: 'bg-brand-marigold text-brand-on-marigold',
};

/** A state in words; wraps rather than truncating, because the words are the point. */
export function State({ tone, children }: { tone: BrandStatus; children: ReactNode }) {
  return (
    <span
      className={`inline-flex min-h-6 items-center rounded-brand-control px-2 py-0.5 text-brand-meta font-semibold ${STATE[tone]}`}
    >
      {children}
    </span>
  );
}

/** Table header cell: eyebrow, numbers right-aligned. */
export function Th({
  children,
  right = false,
  className = '',
}: {
  children?: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap px-3 py-2 text-brand-eyebrow uppercase text-brand-ink-3 first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6 ${right ? 'text-right' : 'text-left'} ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  right = false,
  className = '',
}: {
  children?: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`px-3 py-3 align-top text-brand-ui text-brand-ink first:pl-4 last:pr-4 sm:first:pl-6 sm:last:pr-6 ${right ? 'text-right tabular-nums' : ''} ${className}`}
    >
      {children}
    </td>
  );
}

/** A loading block shaped like what will be there; never a zero. */
export function Pending({ className = 'h-24' }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={`w-full animate-pulse rounded-brand-control bg-brand-sunken motion-reduce:animate-none ${className}`}
    />
  );
}

/** Said when a read failed: never shown as empty. */
export function Unread({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-brand-ui text-brand-critical">
      We could not read {what}, so it is not shown as empty.
      {onRetry && (
        <button type="button" onClick={onRetry} className={LINK}>
          Try again
        </button>
      )}
    </p>
  );
}
