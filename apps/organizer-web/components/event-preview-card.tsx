'use client';

import { CalendarDays, Heart, MapPin } from 'lucide-react';
import { Badge, gradientFor } from '@eticketsgo/web-kit';

/**
 * The event as a buyer will first meet it: the card on the storefront's home and browse pages.
 *
 * ── WHY A COPY OF THE CUSTOMER CARD, NOT THE CARD ITSELF ───────────────────────────
 * The real card lives in customer-web and is built from that app's own pieces: its translated
 * strings, its locale-aware links, its wishlist. None of those exist in the organizer console,
 * and fetching the storefront at runtime to draw one would make the preview depend on another
 * app being up. So this repeats the card's LOOK - the same 4:3 box, gradient fallback, category
 * badge, date with its zone, venue line and "From" price, with the same classes - and none of its
 * behaviour. It is not a link and the heart is a picture, because nothing here can be bought.
 *
 * If the customer card changes shape, this should change with it; the two are kept in step by
 * hand, which is why the classes are copied rather than restyled.
 */
export function EventPreviewCard({
  seed,
  title,
  category,
  imageUrl,
  when,
  where,
  price,
  showFrom,
}: {
  /** Picks the fallback gradient, as the event id does on the storefront. */
  seed: string;
  title: string;
  category: string;
  imageUrl: string | null;
  when: string;
  where: string;
  price: string;
  /** "From" sits beside a price, and not beside "Free". */
  showFrom: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Preview of your event card"
      className="block overflow-hidden rounded-lg border border-border bg-background-surface shadow-sm"
    >
      <div
        className={`relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-gradient-to-br ${gradientFor(seed)}`}
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <span className="select-none text-5xl font-bold text-text-primary/25">
            {title.charAt(0)}
          </span>
        )}
        {category ? (
          <div className="absolute left-3 top-3">
            <Badge tone="info">{category}</Badge>
          </div>
        ) : null}
        <span
          aria-hidden="true"
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-background-surface/90 text-text-secondary shadow-sm"
        >
          <Heart className="h-4 w-4" />
        </span>
      </div>
      <div className="space-y-2.5 p-5">
        <h3 className="line-clamp-1 text-title font-semibold text-text-primary">{title}</h3>
        <div className="space-y-1 text-[0.9375rem] text-text-muted">
          <p className="flex items-center gap-1.5">
            <CalendarDays className="h-4 w-4 shrink-0" />
            {when}
          </p>
          <p className="flex items-center gap-1.5">
            <MapPin className="h-4 w-4 shrink-0" />
            {where}
          </p>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-caption text-text-muted">{showFrom ? 'From' : ''}</span>
          <span className="text-[1.05rem] font-semibold text-text-primary">{price}</span>
        </div>
      </div>
    </div>
  );
}
