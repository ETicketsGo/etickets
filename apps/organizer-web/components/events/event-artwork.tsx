'use client';

import { eventImageSource, gradientFor, type EventImageUse } from '@eticketsgo/web-kit';

/**
 * An event's cover in the shape of the place it is shown, or artwork when it has none.
 *
 * The API cuts each copy to its use - 4:3 for a card, square for a thumbnail - so the box here
 * takes that shape and the copy fills it whole. With no image the box keeps its size and draws
 * the storefront's fallback: the event's own gradient and its initial. A list where events
 * without a picture are shorter than the rest reads as broken rather than unfinished.
 *
 * Decorative (`alt=""`): the title is always printed beside it, and reading it twice to a
 * screen reader user is noise.
 */
export function EventArtwork({
  id,
  title,
  imagePath,
  imageVariants,
  use,
  sizes,
  className = '',
}: {
  id: string;
  title: string;
  imagePath?: string | null;
  imageVariants?: Partial<Record<string, string>> | null;
  use: Extract<EventImageUse, 'card' | 'thumb' | 'banner'>;
  /** How wide the box is drawn, so the browser picks the smaller copy where it will do. */
  sizes?: string;
  className?: string;
}) {
  const source = eventImageSource({ variants: imageVariants, path: imagePath }, use);
  const aspect =
    use === 'card' ? 'aspect-[4/3]' : use === 'banner' ? 'aspect-video' : 'aspect-square';
  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-br ${gradientFor(id)} ${aspect} ${className}`}
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
        <span
          aria-hidden="true"
          className="select-none text-[2em] font-bold uppercase text-text-primary/30"
        >
          {title.trim().charAt(0) || '?'}
        </span>
      )}
    </div>
  );
}
