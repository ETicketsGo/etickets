'use client';

import { useEffect, useState } from 'react';
import { CalendarDays, Heart, MapPin } from 'lucide-react';
import { apiAssetUrl, gradientFor, useToast } from '@eticketsgo/web-kit';
import type { PaginatedEvents } from '@/lib/api';
import { money, dateTime, zoneAbbrev } from '@/lib/format';
import { isSaved, toggleSaved } from '@/lib/saved';
import { Badge } from './ui';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

export function EventCard({ event }: { event: PaginatedEvents['data'][number] }) {
  const t = useTranslations('common.state');
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(isSaved(event.id)), [event.id]);
  /*
    The organizer's image when there is one, the lettered gradient when there is not — or when
    the image fails to load, so a missing file is never a broken-image icon on the front page.
  */
  const imageUrl = apiAssetUrl(event.imagePath);
  const [imageBroken, setImageBroken] = useState(false);
  const toggle = () => {
    const nowSaved = toggleSaved(event);
    setSaved(nowSaved);
    toast.push(nowSaved ? 'Saved to wishlist' : 'Removed from wishlist', 'success');
  };

  return (
    <Link
      href={`/events/${event.slug}`}
      className="group block overflow-hidden rounded-lg border border-border bg-background-surface shadow-sm transition-all duration-300 ease-premium hover:-translate-y-1 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
    >
      <div
        className={`relative flex h-40 items-center justify-center bg-gradient-to-br ${gradientFor(event.id)}`}
      >
        {imageUrl && !imageBroken ? (
          /*
            Whole, over a blurred copy of itself — the same treatment as the event page. Cropped
            to fill the card, a logo or a portrait poster lost its edges on the front page.
          */
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              aria-hidden
              src={imageUrl}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-xl"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt=""
              loading="lazy"
              onError={() => setImageBroken(true)}
              className="relative h-full w-full object-contain transition-transform duration-500 ease-premium group-hover:scale-[1.03]"
            />
          </>
        ) : (
          <span className="select-none text-5xl font-bold text-text-primary/25">
            {event.title.charAt(0)}
          </span>
        )}
        <div className="absolute left-3 top-3">
          <Badge tone="info">{event.category}</Badge>
        </div>
        <button
          type="button"
          aria-label={saved ? 'Remove from wishlist' : 'Save to wishlist'}
          aria-pressed={saved}
          onClick={(e) => {
            e.preventDefault();
            toggle();
          }}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-background-surface/90 text-text-secondary shadow-sm backdrop-blur transition-all hover:scale-105 hover:text-status-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
        >
          <Heart
            className={`h-4 w-4 transition-all ${saved ? 'fill-status-error text-status-error' : ''}`}
          />
        </button>
      </div>

      <div className="space-y-2.5 p-5">
        <h3 className="line-clamp-1 text-title font-semibold text-text-primary transition-colors group-hover:text-action-primary">
          {event.title}
        </h3>
        <div className="space-y-1 text-[0.9375rem] text-text-muted">
          <p className="flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4 shrink-0" />
            {/*
              The venue's clock, named, as on the event page. The card used the reader's browser
              zone (found on QA in "You might also like"), so it could disagree with the page it
              links to. A card saved before the API sent a zone falls back to the browser's.
            */}
            {dateTime(event.nextSessionAt, undefined, event.venue.timezone ?? undefined)}
            {event.nextSessionAt && event.venue.timezone
              ? ` (${zoneAbbrev(event.nextSessionAt, event.venue.timezone)})`
              : ''}
          </p>
          <p className="flex items-center gap-1.5">
            <MapPin className="h-4 w-4 shrink-0" />
            {event.venue.name}, {event.venue.city}
          </p>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3">
          {/*
            "From ₹0" reads as a price that failed to load — and it is the single fact most
            likely to decide whether somebody clicks. Zero already means free everywhere else
            in this app (the home page groups its free section on exactly this test), so the
            card says so, and drops the "From" that makes no sense above it.

            Deliberately keyed on the PRICE and not the event's free flag: a paid event whose
            cheapest tier happens to be zero is also, truthfully, free to get into.
          */}
          <span className="text-caption text-text-muted">
            {event.fromPriceMinor === 0 ? '' : t('from')}
          </span>
          <span className="text-[1.05rem] font-semibold text-text-primary">
            {event.fromPriceMinor == null
              ? '—'
              : event.fromPriceMinor === 0
                ? t('free')
                : money(event.fromPriceMinor, event.currency)}
          </span>
        </div>
      </div>
    </Link>
  );
}
