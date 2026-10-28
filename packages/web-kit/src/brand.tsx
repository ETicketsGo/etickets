'use client';

import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/*
  ── THE BRAND LAYER'S SHARED PIECES ────────────────────────────────────────────────
  docs/design/DESIGN-SYSTEM.md. The few things the three vertical slices (customer home,
  event detail and booking, organizer overview) would otherwise each invent, and invent
  differently: the button, the chip, the status pill and the event artwork with its no-image
  fallback. Everything else is built from the `brand-*` Tailwind tokens directly.

  Every class here resolves only inside an element carrying `data-brand` (brand.css); outside
  one the colours are undefined, which is deliberate - these are not drop-in replacements for
  `Button` and `Badge`, which keep painting every existing screen.

  `design-tokens.spec.ts` checks every colour and type class in this file exists in the preset.
*/

/** One focus treatment: a 2px ring in the brand's focus colour, offset from the surface. */
export const BRAND_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus focus-visible:ring-offset-2 focus-visible:ring-offset-brand-canvas';

export type BrandButtonVariant = 'primary' | 'secondary' | 'quiet' | 'marigold';
export type BrandButtonSize = 'sm' | 'md' | 'lg';

const BRAND_BUTTON_VARIANT: Record<BrandButtonVariant, string> = {
  // Ink on paper, marigold on a stage: the variables swap, the class does not.
  primary: 'bg-brand-action text-brand-on-action hover:bg-brand-action-hover',
  // The second choice beside a primary one: an ink outline on whatever is behind it.
  secondary: 'border border-brand-ink bg-transparent text-brand-ink hover:bg-brand-sunken',
  // Text-only, for low-stakes actions in dense places (a table row, a card footer).
  quiet: 'text-brand-ink hover:bg-brand-sunken',
  /*
    The gold (`marigold` token) button on PAPER: the one "Book tickets" moment on a storefront page. Ink text
    carries it (6.6:1); the fill alone is not a boundary on paper, which is why it is never
    used for anything a person must find by colour.
  */
  marigold: 'bg-brand-marigold text-brand-on-marigold hover:bg-brand-marigold-hover',
};

/* 44px is the default because it is the touch target; `sm` is for dense console rows only. */
const BRAND_BUTTON_SIZE: Record<BrandButtonSize, string> = {
  sm: 'h-9 px-3 text-brand-ui',
  md: 'h-11 px-5 text-brand-ui',
  lg: 'h-12 px-6 text-brand-body',
};

/** The class string for a brand button, for a `<Link>` or `<a>` that must look like one. */
export function brandButtonClasses(
  variant: BrandButtonVariant = 'primary',
  size: BrandButtonSize = 'md',
): string {
  return [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-brand-control font-brand-text font-semibold',
    'transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50',
    BRAND_FOCUS,
    BRAND_BUTTON_VARIANT[variant],
    BRAND_BUTTON_SIZE[size],
  ].join(' ');
}

/**
 * Forwards its ref to the `<button>`, so a caller can put focus back on it (a dialog it
 * opened closes, and the button was disabled meanwhile so the browser dropped focus).
 */
export const BrandButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: BrandButtonVariant;
    size?: BrandButtonSize;
  }
>(function BrandButton(
  { variant = 'primary', size = 'md', className = '', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${brandButtonClasses(variant, size)} ${className}`}
      {...rest}
    />
  );
});

/**
 * A filter or choice chip (a city, a date, a category). `selected` is shown by fill AND by
 * `aria-pressed`, never by colour alone: selected is ink with paper text, so it reads in
 * greyscale too.
 */
export function brandChipClasses(selected: boolean): string {
  return [
    'inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-brand-ui font-medium transition-colors duration-150',
    BRAND_FOCUS,
    selected
      ? 'bg-brand-action text-brand-on-action'
      : 'border border-brand-line bg-transparent text-brand-ink hover:border-brand-ink-3',
  ].join(' ');
}

export type BrandStatus = 'positive' | 'caution' | 'critical' | 'info' | 'neutral' | 'live';

/*
  Text and a 1px edge in the same colour, on a light tint or none (the colour refresh). The edge
  is an inset ring rather than a border so it adds no width: the pill sits exactly where it did.
*/
const BRAND_STATUS: Record<BrandStatus, string> = {
  positive: 'bg-brand-positive-tint text-brand-positive ring-1 ring-inset ring-current',
  caution: 'bg-brand-caution-tint text-brand-caution ring-1 ring-inset ring-current',
  critical: 'bg-brand-critical-tint text-brand-critical ring-1 ring-inset ring-current',
  info: 'bg-brand-info-tint text-brand-info ring-1 ring-inset ring-current',
  // Ended, concluded, transferred: the muted ink, no fill.
  neutral: 'bg-transparent text-brand-ink-3 ring-1 ring-inset ring-current',
  // Today / on sale now / doors open. Marigold, and always with words.
  live: 'bg-brand-marigold text-brand-on-marigold',
};

/** A short state label: "On sale", "Few left", "Paused", "Today". Words always; colour helps. */
export function BrandStatusPill({
  status,
  children,
}: {
  status: BrandStatus;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex h-6 items-center rounded-full px-2.5 text-brand-meta font-semibold ${BRAND_STATUS[status]}`}
    >
      {children}
    </span>
  );
}

export type BrandRatio = '16:9' | '4:3' | '2:3' | '1:1';

const BRAND_RATIO: Record<BrandRatio, string> = {
  '16:9': 'aspect-video',
  '4:3': 'aspect-[4/3]',
  '2:3': 'aspect-[2/3]',
  '1:1': 'aspect-square',
};

/**
 * An event or film picture in a box of a fixed shape, or - when there is no picture, or it
 * fails to load - the brand's typographic artwork for it.
 *
 * ── WHY THE FALLBACK IS THE TITLE, NOT A LETTER ────────────────────────────────────
 * A grid of initials on coloured squares reads as a broken catalogue: it tells the buyer
 * nothing and says the organizer did not finish. The fallback here is a small poster: the
 * category as an eyebrow, the title set in the display face, and a marigold rule, on the
 * stage colour. It carries the same information a photo would have framed, and it is plainly
 * artwork rather than a stock photo pretending to be the organizer's own.
 *
 * Shape is the box's (`ratio`), never the image's, so a row of cards lines up whatever was
 * uploaded. `objectPosition` takes the organizer's focal point (`focalObjectPosition`).
 */
export function EventArtwork({
  src,
  srcSet,
  sizes,
  alt,
  title,
  eyebrow,
  ratio = '4:3',
  objectPosition,
  priority = false,
  className = '',
  tone = 'stage',
}: {
  /**
   * How the no-photo fallback is drawn. `stage` is the dark tile; `lift` is for a card that
   * already sits ON a dark band, where a dark tile has no edge and reads as a black hole: it
   * uses the band's raised surface instead.
   */
  tone?: 'stage' | 'lift';
  src?: string | null;
  srcSet?: string;
  sizes?: string;
  /** Describes the photo. The fallback is labelled with the title instead. */
  alt: string;
  /** The event or film title, set as the artwork when there is no photo. */
  title: string;
  /** A category or kind ("Comedy", "Film"), shown above the title in the fallback. */
  eyebrow?: string;
  ratio?: BrandRatio;
  objectPosition?: string;
  priority?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const missing = !src || failed === src;
  return (
    <div
      className={`relative isolate w-full overflow-hidden rounded-brand-card bg-brand-image-fallback ${BRAND_RATIO[ratio]} ${className}`}
    >
      {missing ? (
        <div
          {...(tone === 'stage' ? { 'data-brand-tone': 'stage' } : {})}
          data-artwork="fallback"
          role="img"
          aria-label={title}
          className={`absolute inset-0 flex min-w-0 flex-col justify-end gap-2 p-[8%] ${
            tone === 'stage' ? 'bg-brand-canvas' : 'bg-brand-sunken'
          }`}
        >
          {eyebrow && (
            <span className="text-brand-eyebrow uppercase text-brand-ink-3">{eyebrow}</span>
          )}
          <span
            className={`break-words font-brand-display font-bold leading-[1.05] tracking-tight text-brand-ink ${
              ratio === '1:1'
                ? 'line-clamp-2 text-brand-ui'
                : ratio === '2:3'
                  ? // A poster is narrow (42% of a phone): display size clipped the title.
                    'line-clamp-5 text-brand-card'
                  : 'line-clamp-3 text-brand-d3'
            }`}
          >
            {title}
          </span>
          <span aria-hidden className="h-1 w-10 rounded-full bg-brand-marigold" />
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          srcSet={srcSet}
          sizes={sizes}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailed(src)}
          className="absolute inset-0 h-full w-full object-cover"
          style={objectPosition ? { objectPosition } : undefined}
        />
      )}
    </div>
  );
}
