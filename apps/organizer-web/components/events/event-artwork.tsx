'use client';

import {
  BookOpen,
  Clapperboard,
  Cpu,
  Drama,
  Frame,
  Laugh,
  Music,
  PartyPopper,
  Presentation,
  Smile,
  Ticket,
  Trophy,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { eventImageSource } from '@eticketsgo/web-kit';

interface CategoryArt {
  icon: LucideIcon;
  tint: string;
  ink: string;
}

/**
 * The placeholder for an event with no picture: its category's tint, its category's icon and a
 * faint dot pattern - never a giant initial, which on QA filled most of every card with the
 * letter "P". Tints are the opaque `tint-*` tokens, so both themes are covered by the tokens'
 * own contrast test.
 */
const CATEGORY_ART: Record<string, CategoryArt> = {
  music: { icon: Music, tint: 'bg-tint-primary', ink: 'text-action-primary' },
  comedy: { icon: Laugh, tint: 'bg-tint-warning', ink: 'text-status-warning' },
  theatre: { icon: Drama, tint: 'bg-tint-info', ink: 'text-status-info' },
  theater: { icon: Drama, tint: 'bg-tint-info', ink: 'text-status-info' },
  film: { icon: Clapperboard, tint: 'bg-background-subtle', ink: 'text-text-secondary' },
  movie: { icon: Clapperboard, tint: 'bg-background-subtle', ink: 'text-text-secondary' },
  conference: { icon: Presentation, tint: 'bg-tint-info', ink: 'text-status-info' },
  tech: { icon: Cpu, tint: 'bg-tint-info', ink: 'text-status-info' },
  workshop: { icon: BookOpen, tint: 'bg-tint-success', ink: 'text-status-success' },
  sports: { icon: Trophy, tint: 'bg-tint-success', ink: 'text-status-success' },
  exhibition: { icon: Frame, tint: 'bg-background-subtle', ink: 'text-text-secondary' },
  festival: { icon: PartyPopper, tint: 'bg-tint-warning', ink: 'text-status-warning' },
  'food & drink': { icon: UtensilsCrossed, tint: 'bg-tint-warning', ink: 'text-status-warning' },
  community: { icon: Users, tint: 'bg-tint-primary', ink: 'text-action-primary' },
  'kids & family': { icon: Smile, tint: 'bg-tint-success', ink: 'text-status-success' },
};
const FALLBACK_ART: CategoryArt = {
  icon: Ticket,
  tint: 'bg-background-subtle',
  ink: 'text-text-secondary',
};

/** The tint and icon for a category, matched case-insensitively; a typed-in one falls back. */
export function categoryArt(category: string | null | undefined): CategoryArt {
  return CATEGORY_ART[(category ?? '').trim().toLowerCase()] ?? FALLBACK_ART;
}

/**
 * An event's cover, or its branded placeholder, in a box the CALLER sizes.
 *
 * - `card`: a wide band (the caller sets the height, about 128-136px) filled with the 16:9 cut
 *   of the picture, so a portrait poster, a square and a panorama all make the same band.
 * - `thumb`: a square.
 *
 * Decorative (`alt=""`): the title is always printed beside it.
 */
export function EventArtwork({
  category,
  imagePath,
  imageVariants,
  use,
  sizes,
  className = '',
}: {
  category?: string | null;
  imagePath?: string | null;
  imageVariants?: Partial<Record<string, string>> | null;
  use: 'card' | 'thumb';
  /** How wide the box is drawn, so the browser picks the smaller copy where it will do. */
  sizes?: string;
  className?: string;
}) {
  const image = { variants: imageVariants, path: imagePath };
  const source =
    use === 'card'
      ? (eventImageSource(image, 'banner') ?? eventImageSource(image, 'card'))
      : eventImageSource(image, 'thumb');
  const art = categoryArt(category);
  const Icon = art.icon;
  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden ${
        use === 'thumb' ? 'aspect-square' : ''
      } ${source ? 'bg-background-subtle' : art.tint} ${className}`}
    >
      {source ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source.src}
          srcSet={source.srcSet}
          sizes={source.srcSet ? sizes : undefined}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <>
          <span
            aria-hidden="true"
            className="absolute inset-0 bg-[radial-gradient(circle,hsl(var(--text-muted)/0.22)_1px,transparent_1.5px)] [background-size:14px_14px]"
          />
          <Icon
            aria-hidden="true"
            strokeWidth={1.6}
            className={`relative opacity-80 ${art.ink} ${use === 'thumb' ? 'h-1/2 w-1/2' : 'h-9 w-9'}`}
          />
        </>
      )}
    </div>
  );
}
