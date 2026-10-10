'use client';

import { Building2, CalendarDays, Heart, MapPin } from 'lucide-react';
import {
  Badge,
  EVENT_IMAGE_ASPECT,
  focalObjectPosition,
  gradientFor,
  type FocalPoint,
} from '@eticketsgo/web-kit';

export interface PreviewImage {
  url: string;
  width: number;
  height: number;
  focal: FocalPoint;
}

export interface BuyerPreviewProps {
  /** Picks the fallback gradient, as the event id does on the storefront. */
  seed: string;
  title: string;
  category: string;
  image: PreviewImage | null;
  when: string;
  where: string;
  organizer: string;
  price: string;
  /** "From" sits beside a price, and not beside "Free". */
  showFrom: boolean;
}

/** `object-position` that keeps the chosen point in view, by the arithmetic the API crops with. */
function position(image: PreviewImage, aspect: number): string {
  return focalObjectPosition(image.width, image.height, aspect, image.focal);
}

/**
 * The event as a buyer will meet it, updated as the organizer types: the card on the
 * storefront's browse pages, and the top of the event page.
 *
 * ── A COPY OF THE STOREFRONT'S LOOK, NOT ITS CODE ──────────────────────────────────
 * The real card and header live in customer-web, built from that app's translated strings and
 * locale links. This repeats their shapes and classes (4:3 card, 16:9 banner, category badge,
 * date with its zone, venue, "From" price) and none of their behaviour: nothing here is a link
 * and the heart is a picture. Crops use `focalObjectPosition`, the arithmetic the API cuts the
 * real copies with, so the crop shown is the crop buyers get.
 *
 * With no picture the storefront draws the event's gradient and its first letter, and so does
 * this - a preview that looked better than the real page would be a promise it cannot keep.
 */
export function BuyerPreview(props: BuyerPreviewProps) {
  return (
    <div className="space-y-4">
      <PreviewCard {...props} />
      <PreviewHeader {...props} />
    </div>
  );
}

export function PreviewCard({
  seed,
  title,
  category,
  image,
  when,
  where,
  price,
  showFrom,
}: BuyerPreviewProps) {
  return (
    <div
      role="group"
      aria-label="Preview of your event card"
      className="overflow-hidden rounded-lg border border-border bg-background-surface"
    >
      <div
        className={`relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-gradient-to-br ${gradientFor(seed)}`}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.url}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition: position(image, EVENT_IMAGE_ASPECT.card) }}
          />
        ) : (
          <span
            aria-hidden="true"
            data-initial={title.trim().charAt(0) || '?'}
            className="select-none text-4xl font-bold uppercase text-text-primary/25 before:content-[attr(data-initial)]"
          />
        )}
        {category ? (
          <div className="absolute left-3 top-3">
            <Badge tone="info">{category}</Badge>
          </div>
        ) : null}
        <span
          aria-hidden="true"
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-background-surface/90 text-text-secondary shadow-sm"
        >
          <Heart className="h-4 w-4" />
        </span>
      </div>
      <div className="space-y-2 p-4">
        <h3 className="line-clamp-2 font-semibold text-text-primary">{title}</h3>
        <div className="space-y-1 text-caption text-text-muted">
          <p className="flex items-center gap-1.5">
            <CalendarDays aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="tabular-nums">{when}</span>
          </p>
          <p className="flex items-center gap-1.5">
            <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{where}</span>
          </p>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-2.5">
          <span className="text-caption text-text-muted">{showFrom ? 'From' : ''}</span>
          <span className="font-semibold tabular-nums text-text-primary">{price}</span>
        </div>
      </div>
    </div>
  );
}

export function PreviewHeader({ title, category, image, where, organizer }: BuyerPreviewProps) {
  return (
    <div
      role="group"
      aria-label="Preview of your event page"
      className="overflow-hidden rounded-lg border border-border bg-background-surface"
    >
      {image ? (
        <div className="relative aspect-video bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition: position(image, EVENT_IMAGE_ASPECT.banner) }}
          />
        </div>
      ) : (
        <div
          aria-hidden="true"
          className="h-16 bg-gradient-to-br from-action-primary/25 via-action-primary/10 to-background-subtle"
        />
      )}
      <div className="p-4">
        {category ? <Badge tone="info">{category}</Badge> : null}
        <p className="mt-2 text-lg font-bold tracking-tight text-text-primary [text-wrap:balance]">
          {title}
        </p>
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-caption text-text-secondary">
          <span className="flex items-center gap-1">
            <MapPin aria-hidden="true" className="h-3.5 w-3.5" />
            {where}
          </span>
          <span className="flex items-center gap-1">
            <Building2 aria-hidden="true" className="h-3.5 w-3.5" />
            {organizer}
          </span>
        </p>
      </div>
    </div>
  );
}
