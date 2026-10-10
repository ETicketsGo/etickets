'use client';

import Link from 'next/link';
import {
  Bell,
  Building2,
  ChevronDown,
  Film,
  Mic,
  MoreHorizontal,
  Music,
  Presentation,
  Sparkles,
  Ticket,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { BadgeTone } from './components';

/*
  ── THE CONSOLE PRIMITIVES, PART TWO ────────────────────────────────────────────────
  The pieces the premium console design (docs/design/eticketsgo-premium-reference.png) is
  built from and that did not exist yet: an icon button that cannot be shipped without a
  name, a real tooltip, a real menu, tabs, the status vocabulary as components, a sold
  meter with its numbers, a picture frame that never distorts or breaks, and the pastel
  icon tile. `Button`, `Card`, `Dialog`, `Drawer`, `DataTable`, `Skeleton` and `EmptyState`
  live in components.tsx and were extended rather than duplicated.

  Every colour here is a token, so each one follows light and dark, the console teal and an
  organization's own accent without knowing which it is in.
*/

/** The focus treatment, the same everywhere: a 2px teal ring with an offset. */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-surface';

// ─── Tooltip ─────────────────────────────────────────────────────────────────────

/**
 * A short label shown on hover AND on keyboard focus, dismissed with Escape (WCAG 1.4.13).
 *
 * Rendered into <body> with `position: fixed`, because a tooltip inside a scrolling list, a
 * card with `overflow: hidden` or a header with a backdrop filter is clipped or mispositioned
 * by its ancestors. Placed below the trigger by default and kept inside the viewport.
 *
 * `describes` decides whether assistive technology hears it. A tooltip that repeats the
 * control's own accessible name (an icon button labelled "Sign out" with a tooltip saying
 * "Sign out") is visual only - announcing it twice is noise. One that ADDS something ("Opens
 * in a new tab") is linked with `aria-describedby`.
 */
export function Tooltip({
  content,
  children,
  side = 'bottom',
  describes = true,
}: {
  content: string;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'right';
  describes?: boolean;
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tip = useRef<HTMLSpanElement>(null);

  const show = (el: HTMLElement) => setAnchor(el.getBoundingClientRect());
  const hide = useCallback(() => {
    setAnchor(null);
    setPos(null);
  }, []);

  useLayoutEffect(() => {
    if (!anchor || !tip.current) return;
    const w = tip.current.offsetWidth;
    const h = tip.current.offsetHeight;
    const gap = 8;
    let top: number;
    let left: number;
    if (side === 'right') {
      top = anchor.top + anchor.height / 2 - h / 2;
      left = anchor.right + gap;
    } else {
      top = side === 'top' ? anchor.top - gap - h : anchor.bottom + gap;
      left = anchor.left + anchor.width / 2 - w / 2;
    }
    setPos({
      top: Math.max(4, Math.min(top, window.innerHeight - h - 4)),
      left: Math.max(4, Math.min(left, window.innerWidth - w - 4)),
    });
  }, [anchor, side]);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [anchor, hide]);

  if (!isValidElement(children)) return children;
  const props = children.props as Record<string, unknown>;
  const chain =
    (name: string, fn: (e: React.SyntheticEvent<HTMLElement>) => void) =>
    (e: React.SyntheticEvent<HTMLElement>) => {
      (props[name] as ((e: unknown) => void) | undefined)?.(e);
      fn(e);
    };

  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    onMouseEnter: chain('onMouseEnter', (e) => show(e.currentTarget)),
    onMouseLeave: chain('onMouseLeave', hide),
    onFocus: chain('onFocus', (e) => {
      // Keyboard focus only: a click also focuses, and would leave a tooltip on screen.
      if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget);
    }),
    onBlur: chain('onBlur', hide),
    onClick: chain('onClick', hide),
    'aria-describedby': describes && anchor ? id : props['aria-describedby'],
  });

  return (
    <>
      {trigger}
      {anchor &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            ref={tip}
            id={id}
            role={describes ? 'tooltip' : undefined}
            aria-hidden={describes ? undefined : true}
            data-tooltip=""
            style={pos ?? { top: 0, left: 0, visibility: 'hidden' }}
            className="pointer-events-none fixed z-[70] max-w-[16rem] rounded-md bg-text-primary px-2.5 py-1.5 text-micro font-medium text-background-surface shadow-md motion-safe:animate-fade-in"
          >
            {content}
          </span>,
          document.body,
        )}
    </>
  );
}

// ─── IconButton ──────────────────────────────────────────────────────────────────

const ICON_BUTTON_VARIANT = {
  ghost: 'text-text-secondary hover:bg-background-subtle hover:text-text-primary',
  outline:
    'border border-border-input bg-background-surface text-text-primary hover:bg-background-subtle',
  secondary: 'bg-action-secondary text-action-secondary-foreground hover:bg-background-subtle',
  tinted: 'bg-tint-primary text-action-primary hover:brightness-95',
  primary:
    'bg-action-primary text-action-primary-foreground shadow-xs hover:bg-action-primary-hover',
  danger: 'text-status-error hover:bg-tint-error',
} as const;

const ICON_BUTTON_SIZE = {
  sm: 'h-8 w-8 [&>svg]:h-4 [&>svg]:w-4',
  md: 'h-10 w-10 [&>svg]:h-[1.125rem] [&>svg]:w-[1.125rem]',
  lg: 'h-11 w-11 [&>svg]:h-5 [&>svg]:w-5',
} as const;

export type IconButtonVariant = keyof typeof ICON_BUTTON_VARIANT;

/**
 * A square button that shows only an icon - and therefore MUST say what it does.
 *
 * `label` is required by the type, not by convention: it becomes the accessible name and the
 * tooltip, so an unlabelled "..." or bell cannot compile. The owner's complaint about the old
 * consoles was "actions are tiny unlabelled icons"; the tooltip makes the name visible to a
 * sighted mouse user too, and keyboard focus shows it as well.
 *
 * `href` renders a link with the same look (the notifications bell is a link, not a button).
 * `badge` is a small count or dot drawn on the corner - describe it in `label` as well
 * ("Notifications, 3 unread"), because a number in a circle is not read out by itself.
 */
export function IconButton({
  label,
  icon: Icon,
  variant = 'ghost',
  size = 'md',
  tooltip = true,
  href,
  badge,
  className = '',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
  label: string;
  icon: LucideIcon;
  variant?: IconButtonVariant;
  size?: keyof typeof ICON_BUTTON_SIZE;
  /** Show the label as a tooltip on hover and focus. On by default. */
  tooltip?: boolean;
  href?: string;
  badge?: ReactNode;
}) {
  const classes = `relative inline-flex shrink-0 items-center justify-center rounded-md transition-[background-color,color,box-shadow,filter] duration-150 active:translate-y-px motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 ${FOCUS_RING} ${ICON_BUTTON_VARIANT[variant]} ${ICON_BUTTON_SIZE[size]} ${className}`;
  const inner = (
    <>
      <Icon aria-hidden />
      {badge != null && badge !== false && (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-action-danger px-1 text-[0.625rem] font-bold leading-none text-action-danger-foreground ring-2 ring-background-surface"
        >
          {badge}
        </span>
      )}
    </>
  );
  const control = href ? (
    <Link href={href} aria-label={label} className={classes}>
      {inner}
    </Link>
  ) : (
    <button type="button" aria-label={label} className={classes} {...props}>
      {inner}
    </button>
  );
  return tooltip ? (
    <Tooltip content={label} describes={false}>
      {control}
    </Tooltip>
  ) : (
    control
  );
}

// ─── IconTile ────────────────────────────────────────────────────────────────────

export type TileTone = 'blue' | 'purple' | 'amber' | 'teal' | 'rose' | 'neutral';

const TILE: Record<TileTone, string> = {
  blue: 'bg-tile-blue text-tile-blue-foreground',
  purple: 'bg-tile-purple text-tile-purple-foreground',
  amber: 'bg-tile-amber text-tile-amber-foreground',
  teal: 'bg-tile-teal text-tile-teal-foreground',
  rose: 'bg-tile-rose text-tile-rose-foreground',
  neutral: 'bg-background-subtle text-text-secondary',
};

const TILE_SIZE = {
  sm: 'h-8 w-8 rounded-md [&>svg]:h-4 [&>svg]:w-4',
  md: 'h-10 w-10 rounded-md [&>svg]:h-5 [&>svg]:w-5',
  lg: 'h-12 w-12 rounded-lg [&>svg]:h-6 [&>svg]:w-6',
} as const;

/** The classes of a pastel tile, for a page that draws its own tile-shaped thing. */
export function tileClasses(tone: TileTone): string {
  return TILE[tone];
}

/**
 * The pastel square behind an icon: stat cards, quick actions, the activity timeline.
 *
 * Decorative (`aria-hidden`): the words beside it carry the meaning. Colour is a grouping cue
 * and never the only one - blue for sales, purple for people is a convention, not a signal.
 */
export function IconTile({
  icon: Icon,
  tone = 'teal',
  size = 'md',
  className = '',
}: {
  icon: LucideIcon;
  tone?: TileTone;
  size?: keyof typeof TILE_SIZE;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center ${TILE[tone]} ${TILE_SIZE[size]} ${className}`}
    >
      <Icon />
    </span>
  );
}

// ─── StatusPill and the status vocabulary ────────────────────────────────────────

export type PillTone = BadgeTone | 'primary' | 'marquee';

const PILL: Record<PillTone, { pill: string; dot: string }> = {
  success: { pill: 'bg-tint-success text-status-success', dot: 'bg-status-success' },
  warning: { pill: 'bg-tint-warning text-status-warning', dot: 'bg-status-warning' },
  error: { pill: 'bg-tint-error text-status-error', dot: 'bg-status-error' },
  info: { pill: 'bg-tint-info text-status-info', dot: 'bg-status-info' },
  neutral: { pill: 'bg-background-subtle text-text-secondary', dot: 'bg-text-muted' },
  primary: { pill: 'bg-tint-primary text-action-primary', dot: 'bg-action-primary' },
  marquee: { pill: 'bg-tint-marquee text-marquee', dot: 'bg-marquee-fill' },
};

/**
 * A status as a pill: a dot AND words, never colour alone.
 *
 * Opaque tints (`bg-tint-*`), so the pill is legible on a card, on the canvas and laid over
 * an image - the reference puts "Upcoming" on the artwork of an event card. Every pair is in
 * `token-contrast.test.ts`. Prefer the vocabulary components below; this is the primitive
 * they are built on, for a status that is not one of them.
 */
export function StatusPill({
  tone = 'neutral',
  children,
  dot = true,
  size = 'md',
  className = '',
  title,
}: {
  tone?: PillTone;
  children: ReactNode;
  dot?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  /** The full text when the visible words are truncated. */
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full font-semibold ${
        size === 'sm' ? 'px-2 py-0.5 text-[0.6875rem]' : 'px-2.5 py-0.5 text-micro'
      } ${PILL[tone].pill} ${className}`}
    >
      {dot && (
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${PILL[tone].dot}`} />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/**
 * An event's lifecycle, in the platform's words (DESIGN-DIRECTION):
 * Draft -> In review -> Approved -> Published -> Ended / Cancelled.
 *
 * "Approved" exists in the vocabulary and in this type, but no event status the API stores
 * today means it - `lifecycleOf` never returns it, so it is shown only where a page has data
 * that genuinely says so.
 */
export type Lifecycle = 'draft' | 'in-review' | 'approved' | 'published' | 'ended' | 'cancelled';

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  draft: 'Draft',
  'in-review': 'In review',
  approved: 'Approved',
  published: 'Published',
  ended: 'Ended',
  cancelled: 'Cancelled',
};

const LIFECYCLE_TONE: Record<Lifecycle, PillTone> = {
  draft: 'neutral',
  'in-review': 'warning',
  approved: 'info',
  published: 'success',
  ended: 'neutral',
  cancelled: 'error',
};

/**
 * The lifecycle step for an `EventStatus` from the API, or null for one it does not know.
 *
 * PAUSED and SOLD_OUT are Published: they are about SELLING, which is the selling pill's
 * job, and calling a paused event anything but published would hide that it is live and
 * visible. COMPLETED and ARCHIVED are both Ended to the person reading the list.
 */
export function lifecycleOf(status: string | null | undefined): Lifecycle | null {
  switch ((status ?? '').toUpperCase()) {
    case 'DRAFT':
      return 'draft';
    case 'UNDER_REVIEW':
      return 'in-review';
    case 'APPROVED':
      return 'approved';
    case 'PUBLISHED':
    case 'PAUSED':
    case 'SOLD_OUT':
      return 'published';
    case 'COMPLETED':
    case 'ARCHIVED':
      return 'ended';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return null;
  }
}

export function LifecyclePill({ status, size }: { status: Lifecycle; size?: 'sm' | 'md' }) {
  return (
    <StatusPill tone={LIFECYCLE_TONE[status]} size={size}>
      {LIFECYCLE_LABEL[status]}
    </StatusPill>
  );
}

/**
 * Whether something is on sale, ONLY as the server's unified eligibility says.
 *
 * "Selling" | "Partly selling: <short reason>" | "Not selling: <short reason>". A partly
 * eligible event must never read as plain "Selling", so the reason is required by the type
 * for the two states that need one. The page maps the server's answer to `state`; this
 * component decides nothing, and checkout stays the enforcement point.
 */
export type SellingState =
  { state: 'selling' } | { state: 'partly'; reason: string } | { state: 'not'; reason: string };

export function sellingLabel(s: SellingState): string {
  if (s.state === 'selling') return 'Selling';
  return `${s.state === 'partly' ? 'Partly selling' : 'Not selling'}: ${s.reason}`;
}

export function SellingPill({ size, ...s }: SellingState & { size?: 'sm' | 'md' }) {
  const label = sellingLabel(s as SellingState);
  const tone: PillTone =
    s.state === 'selling' ? 'success' : s.state === 'partly' ? 'warning' : 'neutral';
  return (
    <StatusPill tone={tone} size={size} title={label}>
      {label}
    </StatusPill>
  );
}

/** "Setup complete" or "<n> things to set up" - never "Ready to sell". */
export function setupLabel(missing: number): string {
  if (missing <= 0) return 'Setup complete';
  return `${missing} ${missing === 1 ? 'thing' : 'things'} to set up`;
}

export function SetupPill({ missing, size }: { missing: number; size?: 'sm' | 'md' }) {
  return (
    <StatusPill tone={missing <= 0 ? 'success' : 'warning'} size={size}>
      {setupLabel(missing)}
    </StatusPill>
  );
}

// ─── ProgressMeter ───────────────────────────────────────────────────────────────

const METER_FILL: Record<PillTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
  neutral: 'bg-text-muted',
  primary: 'bg-action-primary',
  marquee: 'bg-marquee-fill',
};

const count = new Intl.NumberFormat('en-US');

/**
 * The percentage to SHOW for value of max.
 *
 * Rounded down, so 199 of 200 reads 99% rather than a sold-out-looking 100%, and anything
 * above zero but under one percent reads "<1%" rather than a "0%" that looks like no sales.
 * Exported for the pages that print the figure elsewhere.
 */
export function meterPercent(value: number, max: number): string {
  if (max <= 0) return '';
  if (value >= max) return '100%';
  if (value <= 0) return '0%';
  const pct = Math.floor((value / max) * 100);
  return pct === 0 ? '<1%' : `${pct}%`;
}

/**
 * "45 / 100 sold" with the bar and the percentage - the reference's event-card meter.
 *
 * The numbers are written out beside the bar because the bar alone is a picture of a number:
 * the meter role carries them for assistive technology too. A capacity of zero (not set yet)
 * shows the count alone, with no bar to pretend there is a denominator. The fill is clamped
 * so comps or a lowered capacity cannot draw past the end.
 */
export function ProgressMeter({
  value,
  max,
  unit = 'sold',
  label,
  tone = 'primary',
  size = 'md',
}: {
  value: number;
  max: number;
  /** The word after the numbers: "sold", "checked in". */
  unit?: string;
  /** Accessible name of the meter. Defaults to "45 of 100 sold". */
  label?: string;
  tone?: PillTone;
  size?: 'sm' | 'md';
}) {
  const hasMax = max > 0;
  const pct = hasMax ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const name = label ?? (hasMax ? `${value} of ${max} ${unit}` : `${value} ${unit}`);
  return (
    <div className="min-w-0">
      {hasMax && (
        <div
          role="meter"
          aria-label={name}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={Math.min(value, max)}
          aria-valuetext={`${name}, ${meterPercent(value, max)}`}
          className={`w-full overflow-hidden rounded-full bg-background-subtle ${size === 'sm' ? 'h-1.5' : 'h-2'}`}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${METER_FILL[tone]}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div
        className={`flex items-baseline justify-between gap-2 tabular-nums ${hasMax ? 'mt-1.5' : ''} ${size === 'sm' ? 'text-micro' : 'text-caption'}`}
        aria-hidden={hasMax ? true : undefined}
      >
        <span className="truncate text-text-secondary">
          <span className="font-semibold text-text-primary">{count.format(value)}</span>
          {hasMax && ` / ${count.format(max)}`} {unit}
        </span>
        {hasMax && <span className="shrink-0 text-text-muted">{meterPercent(value, max)}</span>}
      </div>
    </div>
  );
}

// ─── ImageFrame ──────────────────────────────────────────────────────────────────

export type ImageRatio = '16:9' | '2:3' | '1:1' | '3:2' | '21:9';

const RATIO: Record<ImageRatio, string> = {
  '16:9': 'aspect-video',
  '2:3': 'aspect-[2/3]',
  '1:1': 'aspect-square',
  '3:2': 'aspect-[3/2]',
  '21:9': 'aspect-[21/9]',
};

export type ImageCategory =
  'event' | 'movie' | 'venue' | 'music' | 'comedy' | 'sports' | 'conference' | 'other';

const CATEGORY_ICON: Record<ImageCategory, LucideIcon> = {
  event: Ticket,
  movie: Film,
  venue: Building2,
  music: Music,
  comedy: Mic,
  sports: Trophy,
  conference: Presentation,
  other: Sparkles,
};

/**
 * A picture in a box of a fixed shape: never stretched, never a broken-image icon.
 *
 * - The SHAPE is the box's, not the image's (`ratio`), with `object-fit: cover`, so a list of
 *   cards lines up whatever was uploaded. `objectPosition` takes the organizer's focal point.
 * - No `src`, or one that fails to load, draws the branded placeholder for the `category` -
 *   navy to teal with the category's icon and, if given, a short label (the venue's name).
 *   It is clearly artwork, never a stock photo standing in for the organizer's own.
 * - `alt` is required by the type. Pass the empty string only for an image that is purely
 *   decorative next to text that already says what it shows.
 * - Lazy-loaded and decoded off the main thread unless `priority` (the first card on screen).
 * - `overlay` is laid over the top-left corner: the status pill on an event card.
 */
export function ImageFrame({
  src,
  srcSet,
  sizes,
  alt,
  ratio = '16:9',
  category = 'event',
  placeholderLabel,
  objectPosition,
  overlay,
  priority = false,
  rounded = 'lg',
  className = '',
}: {
  src?: string | null;
  srcSet?: string;
  sizes?: string;
  alt: string;
  ratio?: ImageRatio;
  category?: ImageCategory;
  placeholderLabel?: string;
  objectPosition?: string;
  overlay?: ReactNode;
  priority?: boolean;
  rounded?: 'none' | 'md' | 'lg';
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const broken = !src || failed === src;
  const Icon = CATEGORY_ICON[category];
  const corner = rounded === 'none' ? '' : rounded === 'md' ? 'rounded-md' : 'rounded-lg';
  return (
    <div
      className={`relative isolate w-full overflow-hidden bg-background-subtle ${RATIO[ratio]} ${corner} ${className}`}
    >
      {broken ? (
        <div
          role={alt ? 'img' : undefined}
          aria-label={alt || undefined}
          aria-hidden={alt ? undefined : true}
          data-placeholder={category}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-nav p-3 text-center"
        >
          {/* Two soft teal glows and a fine diagonal grain: branded, and plainly artwork. */}
          <span
            aria-hidden
            className="absolute inset-0 opacity-90"
            style={{
              backgroundImage:
                'radial-gradient(120% 90% at 100% 0%, hsl(var(--nav-accent) / 0.38), transparent 55%), radial-gradient(90% 80% at 0% 100%, hsl(var(--nav-active) / 0.9), transparent 60%), repeating-linear-gradient(135deg, hsl(0 0% 100% / 0.035) 0 2px, transparent 2px 10px)',
            }}
          />
          <span className="relative flex h-11 w-11 items-center justify-center rounded-lg bg-white/10 text-nav-accent ring-1 ring-white/15">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          {placeholderLabel && (
            <span className="relative line-clamp-2 max-w-[90%] text-micro font-semibold text-nav-foreground">
              {placeholderLabel}
            </span>
          )}
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
      {overlay && (
        <div className="absolute left-2.5 top-2.5 z-10 max-w-[calc(100%-1.25rem)]">{overlay}</div>
      )}
    </div>
  );
}

// ─── Menu ────────────────────────────────────────────────────────────────────────

export type MenuItem =
  | {
      kind?: 'item';
      label: string;
      onSelect: () => void;
      icon?: LucideIcon;
      danger?: boolean;
      disabled?: boolean;
    }
  | { kind: 'link'; label: string; href: string; icon?: LucideIcon }
  /** Shown, not offered: the reason replaces the action, so nobody hunts for a dead control. */
  | { kind: 'note'; label: string; reason: string }
  | { kind: 'separator' };

type MenuTrigger =
  /** A labelled "More" button with a chevron. `label` is the visible word (default "More"). */
  | { trigger?: 'more'; label?: string; ariaLabel?: string }
  /**
   * The square "..." button. `label` is REQUIRED and is its accessible name and tooltip -
   * name the subject: "More actions for Jazz Night", not "More".
   */
  | { trigger: 'icon'; label: string; ariaLabel?: never };

/**
 * A real menu: `aria-haspopup="menu"`, `role="menu"` with `menuitem`s, Arrow keys and
 * Home/End move, Escape closes and puts focus back on the button, Tab closes and moves on.
 *
 * Two triggers, the two the design uses: a labelled "More" and a square "..." icon button.
 * Both open the same menu. Placed with `position: fixed` from the trigger's rectangle, so it
 * is never clipped by a card or a sideways-scrolling table, opens upwards when there is no
 * room below, and follows its trigger on scroll. Clicks inside stop at the menu, so a
 * clickable table row or card behind it does not also fire.
 *
 * Generalised from the organizer events list's `MoreMenu`, which is the behaviour the e2e
 * suite already exercises; new pages should use this one.
 */
export function Menu({
  items,
  align = 'end',
  size = 'md',
  ...trigger
}: MenuTrigger & {
  items: MenuItem[];
  align?: 'start' | 'end';
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const isIcon = trigger.trigger === 'icon';
  const visible = isIcon ? '' : (trigger.label ?? 'More');
  const name = isIcon ? trigger.label : (trigger.ariaLabel ?? visible);

  const focusables = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []).filter(
      (el) => el.getAttribute('aria-disabled') !== 'true',
    );

  const place = () => {
    const button = buttonRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!button || !menu) return;
    if (button.bottom < 0 || button.top > window.innerHeight) {
      setOpen(false);
      return;
    }
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const gap = 4;
    const wanted = align === 'end' ? button.right - width : button.left;
    const left = Math.max(8, Math.min(wanted, window.innerWidth - width - 8));
    const below = button.bottom + gap;
    const top =
      below + height > window.innerHeight - 8 && button.top - gap - height > 8
        ? button.top - gap - height
        : below;
    setPos({ top, left });
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    placeRef.current();
    const follow = () => placeRef.current();
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !pos) return;
    focusables()[0]?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!pos]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = focusables();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus({ preventScroll: true });
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(list.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') setOpen(false);
  };

  const height = size === 'sm' ? 'h-8' : 'h-9';
  const triggerProps = {
    ref: buttonRef,
    type: 'button' as const,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => setOpen((o) => !o),
    onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' && !open) {
        e.preventDefault();
        setOpen(true);
      }
    },
  };
  const row =
    'flex w-full min-h-[2.5rem] items-center gap-2.5 rounded-md px-3 py-2 text-left text-ui focus-visible:outline-none focus-visible:bg-background-subtle';

  return (
    <div ref={wrapRef} className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      {isIcon ? (
        <Tooltip content={name} describes={false}>
          <button
            {...triggerProps}
            aria-label={name}
            className={`inline-flex ${height} ${size === 'sm' ? 'w-8' : 'w-9'} items-center justify-center rounded-md border border-border-input bg-background-surface text-text-secondary transition-colors duration-150 hover:bg-background-subtle hover:text-text-primary active:translate-y-px motion-reduce:transition-none ${FOCUS_RING}`}
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </Tooltip>
      ) : (
        <button
          {...triggerProps}
          aria-label={name !== visible ? name : undefined}
          className={`inline-flex ${height} items-center gap-1 rounded-md border border-border-input bg-background-surface px-3 text-ui font-medium text-text-primary transition-colors duration-150 hover:bg-background-subtle active:translate-y-px motion-reduce:transition-none ${FOCUS_RING}`}
        >
          {visible}
          <ChevronDown
            aria-hidden
            className={`h-4 w-4 text-text-muted transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          />
        </button>
      )}
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={name}
          onKeyDown={onMenuKey}
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          className="fixed z-50 w-60 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-background-elevated p-1 shadow-lg motion-safe:animate-scale-in"
        >
          {items.map((it, i) => {
            if (it.kind === 'separator')
              return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-border" />;
            if (it.kind === 'link') {
              const Icon = it.icon;
              return (
                <Link
                  key={it.label}
                  href={it.href}
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => setOpen(false)}
                  className={`${row} text-text-primary hover:bg-background-subtle`}
                >
                  {Icon && <Icon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />}
                  {it.label}
                </Link>
              );
            }
            if (it.kind === 'note')
              return (
                <div
                  key={it.label}
                  role="menuitem"
                  aria-disabled="true"
                  className="px-3 py-2 text-ui"
                >
                  <span className="block text-text-muted">{it.label}</span>
                  <span className="mt-0.5 block text-caption text-text-muted">{it.reason}</span>
                </div>
              );
            const Icon = it.icon;
            return (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={it.disabled || undefined}
                onClick={() => {
                  if (it.disabled) return;
                  close(true);
                  it.onSelect();
                }}
                className={`${row} ${it.disabled ? 'cursor-not-allowed text-text-muted' : 'hover:bg-background-subtle'} ${
                  it.danger && !it.disabled ? 'text-status-error' : 'text-text-primary'
                }`}
              >
                {Icon && <Icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden />}
                {it.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────────────

export interface TabItem<T extends string> {
  value: T;
  label: string;
  /** A count shown after the label - "Sessions 4". Part of the tab's name. */
  count?: number;
  disabled?: boolean;
}

const tabClass = (on: boolean) =>
  `relative inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-t-md px-3 text-ui font-medium transition-colors duration-150 motion-reduce:transition-none ${FOCUS_RING} focus-visible:ring-offset-0 ${
    on
      ? 'text-text-primary after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-action-primary'
      : 'text-text-secondary hover:text-text-primary'
  }`;

function TabCount({ n, on }: { n: number; on: boolean }) {
  return (
    <span
      className={`rounded-full px-1.5 py-px text-[0.6875rem] font-semibold tabular-nums ${
        on ? 'bg-tint-primary text-action-primary' : 'bg-background-subtle text-text-secondary'
      }`}
    >
      {n}
    </span>
  );
}

/**
 * Tabs that switch a panel in place (WAI-ARIA tabs, automatic activation).
 *
 * One tab stop: Arrow Left/Right move AND select, Home/End jump, and Tab goes on into the
 * panel. `id` ties each tab to its `TabPanel` - pass the same `id` to both. For tabs that
 * are separate PAGES (an event's Overview / Sessions / Bookings routes), use `TabLinks`,
 * which is navigation and says so.
 *
 * The strip scrolls sideways on a phone rather than wrapping, so the underline stays one line.
 */
export function Tabs<T extends string>({
  id,
  label,
  tabs,
  value,
  onChange,
}: {
  id: string;
  label: string;
  tabs: TabItem<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = tabs.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const at = enabled.indexOf(tabs.findIndex((t) => t.value === value));
    let next = -1;
    if (e.key === 'ArrowRight') next = enabled[(at + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
      className="flex max-w-full gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {tabs.map((t, i) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${t.value}`}
            aria-selected={on}
            aria-controls={`${id}-panel-${t.value}`}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.value)}
            className={`${tabClass(on)} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {t.label}
            {t.count != null && <TabCount n={t.count} on={on} />}
          </button>
        );
      })}
    </div>
  );
}

/** The panel for one tab of `Tabs`. Rendered only while selected. */
export function TabPanel({
  tabsId,
  value,
  selected,
  children,
  className = '',
}: {
  tabsId: string;
  value: string;
  selected: string;
  children: ReactNode;
  className?: string;
}) {
  if (value !== selected) return null;
  return (
    <div
      role="tabpanel"
      id={`${tabsId}-panel-${value}`}
      aria-labelledby={`${tabsId}-tab-${value}`}
      tabIndex={0}
      className={`pt-5 focus-visible:outline-none ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The same strip for tabs that are separate pages: links, with `aria-current="page"` on the
 * one you are on. Not `role="tab"` - a tab promises to switch a panel in place, and these
 * navigate.
 */
export function TabLinks({
  label,
  links,
  current,
}: {
  label: string;
  links: { href: string; label: string; count?: number }[];
  /** The href of the page being shown. */
  current: string;
}) {
  return (
    <nav aria-label={label} className="max-w-full overflow-x-auto [scrollbar-width:none]">
      <ul className="flex gap-1 border-b border-border">
        {links.map((l) => {
          const on = l.href === current;
          return (
            <li key={l.href} className="shrink-0">
              <Link href={l.href} aria-current={on ? 'page' : undefined} className={tabClass(on)}>
                {l.label}
                {l.count != null && <TabCount n={l.count} on={on} />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ─── Notifications ───────────────────────────────────────────────────────────────

/**
 * The header's notifications control: a bell that links to the notification centre, with
 * the unread count when the app knows it. The count is in the accessible name as well as on
 * the badge. `unread` undefined (still loading, or the app has no count) shows no badge -
 * never a made-up one.
 */
export function NotificationsButton({ href, unread }: { href: string; unread?: number }) {
  const n = unread ?? 0;
  return (
    <IconButton
      href={href}
      icon={Bell}
      label={n > 0 ? `Notifications, ${n} unread` : 'Notifications'}
      badge={n > 0 ? (n > 99 ? '99+' : n) : undefined}
    />
  );
}
