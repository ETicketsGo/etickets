'use client';

import { Heart } from 'lucide-react';
import { brandButtonClasses } from '@eticketsgo/web-kit';
import { useSavedEvents } from '@/lib/use-live-events';
import { useBuyability } from '@/lib/use-buyability';
import { Link } from '@/i18n/navigation';
import { AccountHeading, AccountPage } from '@/components/account-brand';
import { EventTile, Placeholder } from '@/components/home/parts';
import { BrandEmpty, SaveEventButton } from '@/components/storefront-brand';

/*
  Saved events on the brand layer: the same 4:3 event card as Explore and the home page, with
  the same heart over its corner to un-save it, on paper. It was the old shadowed card. The
  same events, the same order, the same note about events no longer on sale.
*/

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
  /*
    The price or the reason there is none, from each event's own sessions, as on Explore and
    the home page: the brand card never shows "From Rs 799" over a show that is sold out.
  */
  const states = useBuyability(
    events.map((e) => e.slug),
    50,
  );

  return (
    <AccountPage width="wide">
      <AccountHeading
        title="Saved events"
        lead={<>Events you&apos;ve hearted - book before they sell out.</>}
      />

      {!ready ? (
        <div
          className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          aria-busy="true"
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <Placeholder key={i} className="aspect-[4/3] w-full" />
          ))}
        </div>
      ) : events.length > 0 ? (
        <ul className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {events.map((e) => (
            <li key={e.id} className="relative">
              <EventTile event={e} state={states.get(e.slug)} showCity />
              <SaveEventButton event={e} />
            </li>
          ))}
        </ul>
      ) : (
        <BrandEmpty
          title={
            noLongerOnSale > 0 ? 'None of your saved events are on sale' : 'No saved events yet'
          }
          hint="Tap the heart on any event to save it here."
          headingLevel="h2"
          action={
            <Link href="/events" className={brandButtonClasses('primary', 'md')}>
              <Heart className="h-4 w-4" aria-hidden />
              Browse events
            </Link>
          }
        />
      )}

      {ready && noLongerOnSale > 0 ? (
        <p className="text-brand-meta text-brand-ink-2">
          {noLongerOnSale === 1
            ? '1 saved event is no longer on sale, so it is not shown.'
            : `${noLongerOnSale} saved events are no longer on sale, so they are not shown.`}
        </p>
      ) : null}
    </AccountPage>
  );
}
