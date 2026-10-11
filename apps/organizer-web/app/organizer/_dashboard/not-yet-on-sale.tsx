'use client';

import Link from 'next/link';
import { FileText, ShieldCheck } from 'lucide-react';
import {
  ButtonLink,
  IconTile,
  LifecyclePill,
  SectionLink,
  dateOnly,
  lifecycleOf,
} from '@eticketsgo/web-kit';
import type { EventListRow } from '@/components/events/event-list-model';

/** How many draft and in-review events the group draws before "n more". */
export const NOT_YET_SHOWN = 2;

/**
 * Draft and in-review events, in their own group under the upcoming events.
 *
 * They used to be listed AS upcoming events, beside ones people can buy tickets for, with the
 * same card and nothing to say which were which. Here the heading says it, the pill says where each
 * one is (Draft, In review), and there is no "Selling" pill at all: nothing is on sale to be
 * described. The action is to carry on (a draft) or to look (in review).
 */
export function NotYetOnSale({ events, total }: { events: EventListRow[]; total: number }) {
  if (events.length === 0) return null;
  const rest = total - events.length;
  return (
    <section
      aria-labelledby="not-yet-heading"
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-background-surface shadow-xs"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h2 id="not-yet-heading" className="font-display text-ui font-bold text-text-primary">
            Not yet on sale
            <span className="ml-1.5 font-semibold tabular-nums text-text-muted">({total})</span>
          </h2>
          <p className="text-micro text-text-muted">
            Drafts and events in review. Buyers cannot see these yet.
          </p>
        </div>
        <SectionLink href="/organizer/events" srLabel="events">
          All events
        </SectionLink>
      </div>
      <ul className="divide-y divide-border">
        {events.map((e) => {
          const lifecycle = lifecycleOf(e.status);
          const draft = e.status === 'DRAFT';
          const first = e.schedule?.firstStartsAt;
          return (
            <li key={e.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5 sm:px-4">
              <IconTile
                icon={draft ? FileText : ShieldCheck}
                tone={draft ? 'amber' : 'blue'}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui font-semibold text-text-primary" title={e.title}>
                  <Link
                    href={`/organizer/events/${e.id}`}
                    className="rounded-sm hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {e.title}
                  </Link>
                </p>
                <p className="truncate text-caption text-text-muted">
                  {first ? `First show ${dateOnly(first)}` : 'No date set yet'}
                  {e.venue?.name ? ` - ${e.venue.name}` : ''}
                </p>
                {lifecycle ? (
                  <span className="mt-1 inline-flex sm:hidden">
                    <LifecyclePill status={lifecycle} size="sm" />
                  </span>
                ) : null}
              </div>
              {lifecycle ? (
                <span className="max-sm:hidden">
                  <LifecyclePill status={lifecycle} size="sm" />
                </span>
              ) : null}
              <ButtonLink href={`/organizer/events/${e.id}`} variant="tinted" size="sm">
                {draft ? 'Continue' : 'View'}
              </ButtonLink>
            </li>
          );
        })}
      </ul>
      {rest > 0 && (
        <p className="border-t border-border px-4 py-2 text-caption text-text-muted">
          <Link
            href="/organizer/events"
            className="rounded-sm font-semibold text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {rest} more {rest === 1 ? 'event' : 'events'}
          </Link>
        </p>
      )}
    </section>
  );
}
