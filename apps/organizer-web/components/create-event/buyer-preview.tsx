'use client';

import { useState } from 'react';
import { Building2, CalendarDays, Heart, MapPin } from 'lucide-react';
import {
  Badge,
  EVENT_IMAGE_ASPECT,
  TabPanel,
  Tabs,
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

type View = 'card' | 'page';

/**
 * The event as a buyer will meet it, updated as the organizer types: the card on the
 * storefront's browse pages, or the top of the event page, one at a time behind two tabs.
 *
 * ── A COPY OF THE STOREFRONT'S LOOK, NOT ITS CODE ──────────────────────────────────
 * The real card and header live in customer-web, built from that app's translated strings and
 * locale links. This repeats their shapes and classes (4:3 card, 16:9 banner, category badge,
 * date with its zone, venue, "From" price) and none of their behaviour: nothing here is a link
 * and the heart is a picture. Crops use `focalObjectPosition`, the arithmetic the API cuts the
 * real copies with, so the crop shown is the crop buyers get.
 *
 * ── NO PICTURE LOOKS LIKE IT WILL LOOK ─────────────────────────────────────────────
 * The previous preview drew a branded placeholder the storefront never shows. A buyer actually
 * sees a pale gradient with the title's first letter on the card, and no banner at all on the
 * event page - so that is what is drawn here, with one line saying a cover would replace it.
 * An honest preview is the best argument for adding a picture.
 *
 * `id` keeps the tabs of the copies on one page (the side panel and the phone disclosure)
 * apart.
 */
export function BuyerPreview({ id, ...props }: BuyerPreviewProps & { id: string }) {
  const [view, setView] = useState<View>('card');
  return (
    <div className="space-y-3">
      <Tabs
        id={id}
        label="Preview"
        value={view}
        onChange={setView}
        tabs={[
          { value: 'card', label: 'Event card' },
          { value: 'page', label: 'Event page' },
        ]}
      />
      <TabPanel tabsId={id} value="card" selected={view}>
        <PreviewCard {...props} />
      </TabPanel>
      <TabPanel tabsId={id} value="page" selected={view}>
        <PreviewHeader {...props} />
      </TabPanel>
      {props.image ? null : (
        <p className="text-caption text-text-muted">
          No cover yet, so buyers see a plain letter card. Add a picture on Basics.
        </p>
      )}
    </div>
  );
}

function LetterArt({ title }: { title: string }) {
  return (
    <div
      className={`absolute inset-0 flex items-center justify-center bg-gradient-to-br ${gradientFor(title)}`}
    >
      <span aria-hidden="true" className="select-none text-5xl font-bold text-text-primary/25">
        {title.trim().charAt(0).toUpperCase() || 'E'}
      </span>
    </div>
  );
}

export function PreviewCard({
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
      className="overflow-hidden rounded-lg border border-border bg-background-surface shadow-sm"
    >
      <div className="relative aspect-[4/3] overflow-hidden">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.url}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition: position(image, EVENT_IMAGE_ASPECT.card) }}
          />
        ) : (
          <LetterArt title={title} />
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
      <div className="space-y-2.5 p-4">
        <h3 className="line-clamp-2 text-title font-semibold text-text-primary">{title}</h3>
        <div className="space-y-1 text-caption text-text-muted">
          <p className="flex items-start gap-1.5">
            <CalendarDays aria-hidden="true" className="mt-px h-4 w-4 shrink-0" />
            <span className="tabular-nums">{when}</span>
          </p>
          <p className="flex items-start gap-1.5">
            <MapPin aria-hidden="true" className="mt-px h-4 w-4 shrink-0" />
            <span className="line-clamp-1 break-all">{where}</span>
          </p>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-caption text-text-muted">{showFrom ? 'From' : ''}</span>
          <span className="text-[1.05rem] font-semibold tabular-nums text-text-primary">
            {price}
          </span>
        </div>
      </div>
    </div>
  );
}

export function PreviewHeader({
  title,
  category,
  image,
  when,
  where,
  organizer,
}: BuyerPreviewProps) {
  return (
    <div
      role="group"
      aria-label="Preview of your event page"
      className="overflow-hidden rounded-lg border border-border bg-background-surface shadow-sm"
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
      ) : null}
      <div className="p-4">
        {category ? <Badge tone="info">{category}</Badge> : null}
        <p className="mt-2 text-xl font-bold tracking-tight text-text-primary [text-wrap:balance]">
          {title}
        </p>
        <div className="mt-2 space-y-1 text-caption text-text-secondary">
          <p className="flex items-start gap-1.5">
            <CalendarDays aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="tabular-nums">{when}</span>
          </p>
          <p className="flex items-start gap-1.5">
            <MapPin aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{where}</span>
          </p>
          <p className="flex items-start gap-1.5">
            <Building2 aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{organizer}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
