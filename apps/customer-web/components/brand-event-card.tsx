'use client';

import { useState } from 'react';
import { CalendarDays, MapPin } from 'lucide-react';
import { BRAND_FOCUS, EventArtwork, eventImageSource } from '@eticketsgo/web-kit';
import type { PaginatedEvents } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { eventZone } from '@/lib/event-when';
import { Link } from '@/i18n/navigation';
import { ContentLabelBadge } from './content-label-badge';
import { FromPrice } from './home/parts';
import { SaveEventButton } from './storefront-brand';

/*
  ── AN EVENT IN A GRID, ON THE BRAND LAYER ───────────────────────────────────────────
  Browse, "You might also like" on the event page and the confirmation's recommendations drew
  the old `EventCard`: a shadowed white card, a blue category badge on the picture, a pastel
  gradient with a letter on it when there was no photo. Those three pages are on paper now.

  The card says exactly what the old one said, in the same order - category, title, the show's
  time in the venue's clock with its zone named, the venue and city, and "From <price>" or
  "Free" - so a buyer comparing events reads the same facts. Only the drawing changed: the 4:3
  picture or the brand's typographic artwork, text under the picture rather than on it, and the
  wishlist heart as a SIBLING of the link (never a button inside it).

  The old `EventCard` stays for the account pages that are not on the brand layer yet.
*/

type ListedEvent = PaginatedEvents['data'][number];

export function BrandEventCard({
  event,
  priority = false,
}: {
  event: ListedEvent;
  /** The first cards on a page are fetched at once; the rest stay lazy. */
  priority?: boolean;
}) {
  const { dateTime, zoneAbbrev } = useFormat();
  const image = eventImageSource({ variants: event.imageVariants, path: event.imagePath }, 'card');
  // The venue's zone, else its country's only one (a saved card can predate the API's answer).
  const zone = eventZone(event);
  const [broken, setBroken] = useState(false);
  return (
    <div className="relative h-full">
      <Link
        href={`/events/${event.slug}`}
        className={`group flex h-full flex-col rounded-brand-card ${BRAND_FOCUS}`}
      >
        <div className="overflow-hidden rounded-brand-card">
          <div className="transition-transform duration-150 motion-safe:group-hover:scale-[1.02]">
            {image && !broken ? (
              /*
                The picture drawn here rather than by EventArtwork, for the two things a grid
                needs that the artwork does not say: the box's size up front (width and height,
                so the page does not jump as pictures arrive) and which pictures to fetch first
                (`fetchpriority` on the first cards only, the rest lazy). The no-photo and
                broken-photo case is still EventArtwork's typographic fallback.
              */
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-brand-card bg-brand-sunken">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.src}
                  srcSet={image.srcSet}
                  sizes="(min-width: 1280px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                  alt=""
                  width={800}
                  height={600}
                  loading={priority ? 'eager' : 'lazy'}
                  // Camel case, as the home page's hero: React 19 writes it as `fetchpriority`.
                  fetchPriority={priority ? 'high' : undefined}
                  decoding="async"
                  onError={() => setBroken(true)}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </div>
            ) : (
              <EventArtwork
                src={null}
                alt=""
                title={event.title}
                eyebrow={event.category}
                ratio="4:3"
              />
            )}
          </div>
        </div>
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-brand-eyebrow uppercase text-brand-ink-3">
          <span>{event.category}</span>
          <ContentLabelBadge label={event.contentLabel} />
        </p>
        <h3 className="mt-1 line-clamp-2 font-brand-display text-brand-card text-brand-ink">
          {event.title}
        </h3>
        <p className="mt-1.5 flex items-start gap-1.5 text-brand-meta text-brand-ink-2">
          <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {/* The venue's clock, named, as on the event page it opens. */}
            {dateTime(event.nextSessionAt, undefined, zone)}
            {event.nextSessionAt && zone ? ` (${zoneAbbrev(event.nextSessionAt, zone)})` : ''}
          </span>
        </p>
        <p className="mt-1 flex items-start gap-1.5 text-brand-meta text-brand-ink-2">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {event.venue.name}, {event.venue.city}
          </span>
        </p>
        <p className="mt-auto pt-2">
          <FromPrice event={event} />
        </p>
      </Link>
      <SaveEventButton event={event} />
    </div>
  );
}
