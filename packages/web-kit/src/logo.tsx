/**
 * The brand, in one place.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * There were three different marks in the product at once: a Lucide ticket glyph inside a
 * rounded blue square (the header, both footers, the marketing nav — each hand-assembled),
 * an unrelated indigo `#4f46e5` square in `icon.svg` that appeared in every browser tab, and
 * the actual brand artwork, which appeared nowhere.
 *
 * Nothing was wrong with any single file. The problem was that the lockup was rebuilt from
 * parts four times, so changing the brand meant finding four places and getting them to
 * agree — which they already did not.
 *
 * ── ONE MARK, TWO DENSITIES ────────────────────────────────────────────────────────
 * `full` carries the motion streaks and the perforation. `compact` drops both. That is not
 * a stylistic variant: below roughly 40px the streaks and the tear line occupy two or three
 * pixels each and turn into grain, so the compact mark gives the ticket and the E the whole
 * box instead. A favicon is glanced at, never read.
 *
 * ── WHY IT IS INLINE SVG AND NOT AN <img> ──────────────────────────────────────────
 * It has to sit on a light page and a dark one, at any size, in a component tree that is
 * sometimes server-rendered. Inline means no second network request before the header can
 * paint, no flash of a missing logo, and `currentColor` available if a monochrome variant is
 * ever needed. The same artwork also exists as a static file for the favicon, the PWA
 * manifest and the OG image, which cannot use a React component.
 */
export type LogoVariant = 'full' | 'compact';

const GRADIENT_STOPS = [
  { offset: 0, color: '#C026D3' },
  { offset: 0.34, color: '#6D28D9' },
  { offset: 0.68, color: '#2563EB' },
  { offset: 1, color: '#22B8F5' },
];

/**
 * The mark alone.
 *
 * `id` disambiguates the gradient and mask. Two of these on one page with the same ids means
 * the second one's defs win for both — a real and confusing bug, because the markup looks
 * correct and only the colours are wrong.
 */
export function LogoMark({
  variant = 'full',
  className,
  id = 'etg',
}: {
  variant?: LogoVariant;
  className?: string;
  id?: string;
}) {
  const gradientId = `${id}-brand`;
  const maskId = `${id}-notch`;
  const compact = variant === 'compact';

  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      role="img"
      aria-label="ETicketsGo"
      focusable="false"
    >
      <defs>
        {/* userSpaceOnUse so the ramp is anchored to the artwork rather than to each shape's
            own box — per-shape gradients restart on every element and the ticket stops
            agreeing with the streaks trailing off it. */}
        <linearGradient
          id={gradientId}
          x1={compact ? 56 : 40}
          y1={compact ? 440 : 400}
          x2={compact ? 456 : 470}
          y2={compact ? 72 : 120}
          gradientUnits="userSpaceOnUse"
        >
          {GRADIENT_STOPS.map((s) => (
            <stop key={s.offset} offset={s.offset} stopColor={s.color} />
          ))}
        </linearGradient>
        {/* The notch is PUNCHED, not painted over. A background-coloured circle works on
            white and leaves a white bite out of the mark on every other surface. */}
        <mask id={maskId}>
          <rect width="512" height="512" fill="#fff" />
          <circle cx={compact ? 452 : 438} cy="256" r="30" fill="#000" />
        </mask>
      </defs>

      {/* One skew on the whole group, so the E cannot drift out of agreement with the ticket
          it sits inside. */}
      <g transform={`translate(${compact ? 6 : 22} 0) skewX(-11)`}>
        <g mask={`url(#${maskId})`}>
          <rect
            x={compact ? 70 : 130}
            y={compact ? 118 : 152}
            width={compact ? 376 : 308}
            height={compact ? 276 : 212}
            rx={compact ? 34 : 26}
            fill={`url(#${gradientId})`}
          />
        </g>

        {!compact && (
          <line
            x1="394"
            y1="176"
            x2="394"
            y2="340"
            stroke="#fff"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray="3 24"
            opacity="0.9"
          />
        )}

        {/* Centred in the ticket by arithmetic rather than by eye. Eyeballed, the E ran four
            pixels past the bottom edge, and the skew turned that into a white spur poking
            out of the lower-left corner into the streaks. */}
        <path
          fill="#fff"
          d={
            compact
              ? 'M128 159h190v46H182v30h118v42h-118v30h140v46H128z'
              : 'M172 182h140v36H212v24h96v32h-96v24h108v36H172z'
          }
        />
      </g>

      {!compact && (
        /* Level while the ticket leans, as in the artwork. Skewing these too reads as a
           mistake rather than as speed. */
        <g fill={`url(#${gradientId})`}>
          <rect x="74" y="186" width="96" height="20" rx="10" />
          <rect x="34" y="246" width="124" height="20" rx="10" />
          <rect x="60" y="306" width="104" height="20" rx="10" />
          <rect x="12" y="186" width="42" height="20" rx="10" opacity="0.7" />
          <rect x="14" y="306" width="30" height="20" rx="10" opacity="0.7" />
        </g>
      )}
    </svg>
  );
}

/**
 * Mark plus wordmark — the lockup that goes in a header or a footer.
 *
 * The wordmark stays live text rather than being drawn into the SVG: it is selectable,
 * searchable, readable by a screen reader without relying on a label, and it re-renders at
 * the reader's own font size. A wordmark baked into artwork does none of that.
 *
 * `aria-hidden` on the mark because the text beside it already says "ETicketsGo" — without
 * it a screen reader announces the brand twice on every page.
 */
export function Logo({
  variant = 'compact',
  markClassName = 'h-8 w-8',
  className,
  showWordmark = true,
  id,
}: {
  variant?: LogoVariant;
  markClassName?: string;
  className?: string;
  showWordmark?: boolean;
  id?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <span aria-hidden={showWordmark} className={`inline-flex shrink-0 ${markClassName}`}>
        <LogoMark variant={variant} id={id} className="h-full w-full" />
      </span>
      {showWordmark && (
        <span className="text-[1.05rem] font-bold tracking-tight text-text-primary">
          ETickets<span className="text-action-primary">Go</span>
        </span>
      )}
    </span>
  );
}
