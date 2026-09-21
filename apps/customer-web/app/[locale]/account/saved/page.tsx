'use client';

import { Heart } from 'lucide-react';
import { EventCard } from '@/components/event-card';
import { useSavedEvents } from '@/lib/use-live-events';
import { ButtonLink, EmptyState } from '@/components/ui';

export default function SavedPage() {
  /*
    Current data, not the copy stored when the heart was pressed.

    This page rendered those stored copies as they were, so a saved show kept its old price
    and date for ever and stayed on the page, looking bookable, long after it was over. Saved
    events are deliberately NOT filtered by location - somebody who saved a show in the city
    they are travelling to wants it there - but anything no longer on sale drops out, and the
    page says how many so a shorter list is explained rather than looking like a loss.
  */
  const { events, ready, noLongerOnSale } = useSavedEvents();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Saved events</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Events you&apos;ve hearted - book before they sell out.
        </p>
      </div>

      {!ready ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-72 animate-pulse rounded-lg border border-border bg-background-subtle"
            />
          ))}
        </div>
      ) : events.length > 0 ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {events.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            noLongerOnSale > 0 ? 'None of your saved events are on sale' : 'No saved events yet'
          }
          hint="Tap the heart on any event to save it here."
          icon={Heart}
          action={<ButtonLink href="/events">Browse events</ButtonLink>}
        />
      )}

      {ready && noLongerOnSale > 0 ? (
        <p className="text-caption text-text-muted">
          {noLongerOnSale === 1
            ? '1 saved event is no longer on sale, so it is not shown.'
            : `${noLongerOnSale} saved events are no longer on sale, so they are not shown.`}
        </p>
      ) : null}
    </div>
  );
}
