'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowRight, CircleAlert, CircleCheck } from 'lucide-react';
import { StatusPill } from '@eticketsgo/web-kit';
import type { NeedsAction } from './overview-model';

/** How many items the list draws; the rest are one link away, with their count. */
export const NEEDS_SHOWN = 3;

/**
 * "Needs action": what is stopping something or may stop it, blocking first, as a compact list.
 *
 * Every row opens the place that fixes it. The list is capped so a long queue (a dozen
 * "tickets blocked" notices) cannot push the page down; what is left is "n more" with a link.
 * With nothing open it is one quiet line, not a hole.
 */
export function NeedsActionCard({
  needs,
  error,
  onRetry,
}: {
  needs: NeedsAction;
  error: boolean;
  onRetry: () => void;
}) {
  const shown = needs.items.slice(0, NEEDS_SHOWN);
  const rest = needs.items.length - shown.length;
  const blocked = needs.blocking > 0;
  return (
    <section
      aria-labelledby="needs-action-heading"
      className={`min-w-0 overflow-hidden rounded-lg border bg-background-surface shadow-xs ${
        blocked ? 'border-status-error/40' : 'border-border'
      }`}
    >
      <div
        className={`flex items-center gap-2 border-b border-border px-4 py-2.5 ${blocked ? 'bg-tint-error/40' : ''}`}
      >
        {blocked ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-status-error" aria-hidden />
        ) : needs.items.length > 0 ? (
          <CircleAlert className="h-4 w-4 shrink-0 text-status-warning" aria-hidden />
        ) : (
          <CircleCheck className="h-4 w-4 shrink-0 text-status-success" aria-hidden />
        )}
        <h2 id="needs-action-heading" className="font-display text-ui font-bold text-text-primary">
          Needs action
          {needs.items.length > 0 ? (
            <span className="ml-1.5 font-semibold tabular-nums text-text-muted">
              ({needs.items.length})
            </span>
          ) : null}
        </h2>
        {needs.items.length > 0 && (
          <p className="ml-auto text-micro text-text-muted">Blocking first</p>
        )}
      </div>
      {error && needs.items.length === 0 ? (
        <p className="px-4 py-3 text-caption text-text-muted">
          We could not load everything that needs you.{' '}
          <button
            type="button"
            onClick={onRetry}
            className="rounded-sm font-semibold text-action-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
        </p>
      ) : needs.items.length === 0 ? (
        <p className="px-4 py-3 text-caption text-text-secondary">
          Nothing needs action right now.
          {needs.suggestions > 0 ? (
            <>
              {' '}
              <Link
                href="/organizer/get-started"
                className="rounded-sm font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {needs.suggestions} optional {needs.suggestions === 1 ? 'step' : 'steps'}
              </Link>
            </>
          ) : null}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {shown.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="group flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.severity === 'blocking' ? 'bg-status-error' : 'bg-status-warning'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-ui font-semibold leading-snug text-text-primary group-hover:text-action-primary">
                        {item.title}
                      </span>
                      <StatusPill
                        tone={item.severity === 'blocking' ? 'error' : 'warning'}
                        dot={false}
                        size="sm"
                      >
                        {item.severity === 'blocking' ? 'Blocking' : 'Warning'}
                      </StatusPill>
                    </span>
                    {item.detail ? (
                      <span className="mt-0.5 line-clamp-1 text-caption text-text-muted max-sm:hidden">
                        {item.detail}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-caption font-semibold text-action-primary">
                    <span className="max-sm:sr-only">{item.actionLabel}</span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {(rest > 0 || needs.suggestions > 0) && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-caption text-text-muted">
              {rest > 0 && (
                <Link
                  href="/organizer/notifications"
                  className="rounded-sm font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {rest} more {rest === 1 ? 'item' : 'items'}
                </Link>
              )}
              {needs.suggestions > 0 && (
                <Link
                  href="/organizer/get-started"
                  className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {needs.suggestions} optional {needs.suggestions === 1 ? 'step' : 'steps'}
                </Link>
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
