/**
 * The ETicketsGo wordmark: the one brand mark on every surface (owner, 2026-10-19).
 *
 * ── WHY ONE COMPONENT ──────────────────────────────────────────────────────────────
 * The storefront drew "ETicketsGo" in the display face with a gold full stop; the organizer
 * console drew its own copy of that; the admin console drew the old purple-to-blue gradient
 * ticket (later its favicon as an <img>); the sign-in pages drew a blue ticket tile; emails
 * and printed tickets wrote the name in a system font. Five pictures of one brand. This is
 * the picture now, and `wordmark.test.tsx` holds each surface to it.
 *
 * ── WHAT MAKES IT THE MARK, NOT JUST THE NAME ──────────────────────────────────────
 * - The display face (Bricolage Grotesque, `font-brand-display`) at its heaviest weight, with
 *   the face's own kerning switched on and tracking pulled in a little, so the letters read
 *   as one shape. Optical sizing is left to the face: at 16px it opens up, at 28px it tightens.
 * - The gold dot is a FULL STOP, not a bullet: it sits on the baseline, it is half again as
 *   wide as a stem, and the gap before it matches the space the "o" leaves at its
 *   right. It is an inline SVG, not a background colour, so it prints (browsers drop
 *   background colours on paper unless told otherwise) and scales with the type.
 * - Gold has two values: `etg-gold` on paper and `etg-gold-on-ink` on an ink band. The dot is
 *   decoration and is never the only thing that carries meaning.
 *
 * ── TONES ──────────────────────────────────────────────────────────────────────────
 * 'light' is ink on paper; 'dark' is paper on ink; 'auto' follows the consoles' `dark` class
 * (the admin top bar flips with the appearance switch). 'brand' takes the colour of the text
 * around it and the storefront's `brand-marigold`, which is the paper gold on paper and the
 * ink-band gold inside a `data-brand-tone="stage"` band (the footer) - so one mark serves both
 * without the caller choosing.
 *
 * ── ACCESSIBLE NAME ────────────────────────────────────────────────────────────────
 * The name is real text, so a screen reader reads "ETicketsGo" and the dot is hidden from it.
 * The product label ("Organizer", "Admin") is real text too, after the name. A link around the
 * mark that has its own `aria-label` ("ETicketsGo home") replaces both, as a label should.
 */
import type { CSSProperties } from 'react';

export type WordmarkSize = 'sm' | 'md' | 'lg' | 'xl';
export type WordmarkTone = 'light' | 'dark' | 'auto' | 'brand';

/** Type sizes. `sm` is the consoles' header and sidebar, `md` the storefront header,
 * `lg` a footer or a sign-in page, `xl` a page with nothing else to look at (a 404). */
const SIZE: Record<WordmarkSize, string> = {
  sm: 'text-[1.125rem]',
  md: 'text-[1.375rem]',
  lg: 'text-[1.625rem]',
  xl: 'text-[2.25rem]',
};

const TONE: Record<WordmarkTone, { text: string; dot: string; label: string; rule: string }> = {
  light: {
    text: 'text-etg-ink',
    dot: 'fill-etg-gold',
    label: 'text-etg-gold-text',
    rule: 'bg-etg-rule-strong',
  },
  dark: {
    text: 'text-etg-on-ink',
    dot: 'fill-etg-gold-on-ink',
    label: 'text-etg-gold-on-ink',
    rule: 'bg-etg-on-ink/25',
  },
  auto: {
    text: 'text-etg-ink dark:text-etg-on-ink',
    dot: 'fill-etg-gold dark:fill-etg-gold-on-ink',
    label: 'text-etg-gold-text dark:text-etg-gold-on-ink',
    rule: 'bg-etg-rule-strong dark:bg-etg-on-ink/25',
  },
  brand: {
    text: '',
    dot: 'fill-brand-marigold',
    label: 'text-brand-gold-text',
    rule: 'bg-brand-line-strong',
  },
};

/*
  The face's own kerning and ligatures, asked for explicitly: some browsers turn kerning off
  for short runs of large text to save time, which is exactly where a wordmark lives.
*/
const TYPE_STYLE: CSSProperties = {
  fontKerning: 'normal',
  fontFeatureSettings: '"kern" 1, "liga" 1',
  fontOpticalSizing: 'auto',
  textRendering: 'optimizeLegibility',
};

/**
 * The full stop. 0.3em across (an 800-weight stem in this face is about 0.2em, and a dot
 * reads smaller than a stem of the same width, so it is drawn half again as wide), 0.06em after
 * the "o", resting on the baseline.
 */
function Dot({ className }: { className: string }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 10 10"
      className={`ml-[0.06em] inline-block h-[0.3em] w-[0.3em] shrink-0 align-baseline ${className}`}
    >
      <circle cx="5" cy="5" r="5" />
    </svg>
  );
}

export function Wordmark({
  size = 'md',
  tone = 'light',
  product,
  stacked = false,
  className = '',
}: {
  size?: WordmarkSize;
  tone?: WordmarkTone;
  /** A product label set beside the mark in small capitals: "Organizer", "Admin". */
  product?: string;
  /**
   * The label under the name instead of beside it, for a column too narrow for both on one
   * line (the organizer sidebar is 14.5rem with a collapse control beside the mark): a label
   * cut to "ORG..." names nothing.
   */
  stacked?: boolean;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <span
      data-wordmark=""
      className={`inline-flex min-w-0 leading-none ${
        stacked ? 'flex-col items-start gap-[0.35em]' : 'items-center gap-[0.55em]'
      } ${SIZE[size]} ${className}`}
    >
      <span
        className={`inline-flex items-baseline whitespace-nowrap font-brand-display font-extrabold tracking-[-0.035em] ${t.text}`}
        style={TYPE_STYLE}
      >
        ETicketsGo
        <Dot className={t.dot} />
      </span>
      {product && (
        <>
          {!stacked && <span aria-hidden className={`h-[0.8em] w-px shrink-0 ${t.rule}`} />}
          {/* A space for a screen reader and for copy-paste ("ETicketsGo Organizer"), which the
              flex gap does not give. */}
          <span className="sr-only"> </span>
          <span
            className={`truncate font-brand-text text-[length:max(0.6875rem,0.5em)] font-semibold uppercase tracking-[0.16em] ${t.label}`}
          >
            {product}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * The mark folded to one letter, for a collapsed rail: the "E" and its gold full stop on an
 * ink tile, the same picture as the consoles' favicons. Named "ETicketsGo" for assistive
 * technology unless the link around it says more.
 */
export function WordmarkMonogram({
  className = 'h-9 w-9',
  tone = 'dark',
  label = 'ETicketsGo',
}: {
  className?: string;
  /**
   * 'dark' is paper letters on an ink tile (the organizer favicon); 'light' is ink letters on a
   * paper tile (the storefront favicon); 'brand' is the console desk's ink, which turns to paper
   * when the desk goes dark, so the tile always stands off the sidebar.
   */
  tone?: 'dark' | 'light' | 'brand';
  /** Pass `null` when the surrounding link already names it. */
  label?: string | null;
}) {
  const tile =
    tone === 'dark'
      ? 'bg-etg-ink text-etg-on-ink'
      : tone === 'light'
        ? 'border border-etg-rule bg-etg-bg text-etg-ink'
        : 'bg-brand-ink text-brand-canvas';
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      data-wordmark-monogram=""
      className={`inline-flex shrink-0 items-center justify-center rounded-[28%] font-brand-display font-extrabold leading-none ${tile} ${className}`}
    >
      <span
        className="inline-flex items-baseline text-[1.1rem] tracking-[-0.035em]"
        style={TYPE_STYLE}
      >
        E
        <Dot className="fill-etg-gold" />
      </span>
    </span>
  );
}
