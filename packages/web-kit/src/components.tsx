'use client';

import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Info,
  Loader2,
  Search,
  Star,
  TriangleAlert,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type JSXElementConstructor,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { titleCase } from './format';
import { tileClasses, type TileTone } from './primitives';

const focus =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas';

const btnBase = `inline-flex items-center justify-center gap-2 rounded-md text-button font-semibold transition-all duration-200 ease-premium active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none ${focus}`;

/*
  `md` stays 44px, the touch-target size, because it is the size most buttons already are and a
  smaller default would move every form in three apps. `lg` is a page's one big call to action.
*/
const sizes = {
  sm: 'h-9 px-3.5',
  md: 'h-11 px-5',
  lg: 'h-12 px-6 text-[1rem]',
};

const variants = {
  primary:
    'bg-action-primary text-action-primary-foreground shadow-sm hover:bg-action-primary-hover hover:shadow-md',
  secondary: 'bg-action-secondary text-action-secondary-foreground hover:bg-action-secondary/70',
  danger: 'bg-action-danger text-action-danger-foreground shadow-sm hover:brightness-105',
  // Also a control, so also `border-border-input`: an outline button IS its outline.
  outline:
    'border border-border-input bg-background-surface text-text-primary hover:bg-background-subtle hover:border-text-secondary',
  ghost: 'text-text-secondary hover:bg-background-subtle hover:text-text-primary',
  /*
    The reference's "Manage" button: the accent's own tint under the accent. A strong second
    action that does not compete with the page's one primary button.
  */
  tinted: 'bg-tint-primary text-action-primary hover:brightness-95 dark:hover:brightness-125',
};
export type ButtonVariant = keyof typeof variants;

/**
 * The button. `primary` is the page's ONE main action; `secondary`, `outline`, `tinted` and
 * `ghost` are everything else, `danger` is the one that deletes.
 *
 * `loading` disables it and swaps the icon for a spinner without changing its width, and says
 * so to assistive technology (`aria-busy`). `icon` is a leading icon; the words are still the
 * name - an icon-only control is `IconButton`, which requires one.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  loading,
  icon: Icon,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: keyof typeof sizes;
  loading?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <button
      {...props}
      className={`${btnBase} ${sizes[size]} ${variants[variant]} ${className}`}
      disabled={loading || props.disabled}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        Icon && <Icon className="h-4 w-4" aria-hidden />
      )}
      {children}
    </button>
  );
}

/**
 * Whatever renders ButtonLink's anchor, given the props ButtonLink hands it.
 *
 * `JSXElementConstructor` rather than `ComponentType`: the latter also compares `propTypes`,
 * so a Link whose `href` accepts a URL object as well as a string was refused for accepting
 * MORE than ButtonLink passes — which is backwards for a prop that is only ever called.
 */
export type ButtonLinkComponent = JSXElementConstructor<{
  href: string;
  className?: string;
  children?: ReactNode;
}>;

export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  className = '',
  icon: Icon,
  children,
  linkComponent: LinkComponent = Link,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: keyof typeof sizes;
  className?: string;
  icon?: LucideIcon;
  children: ReactNode;
  /*
    The link that renders the anchor. `next/link` unless the app says otherwise.

    The customer storefront is translated and its URLs carry the locale, so a plain
    `next/link` there sent a French reader to the English page every time they pressed a
    button — "Choose seats", "Back to event", "View tickets". The storefront passes its
    locale-aware Link; organizer and admin have no locale in the URL and keep the default.
  */
  linkComponent?: ButtonLinkComponent;
}) {
  return (
    <LinkComponent
      href={href}
      className={`${btnBase} ${sizes[size]} ${variants[variant]} ${className}`}
    >
      {Icon && <Icon className="h-4 w-4" aria-hidden />}
      {children}
    </LinkComponent>
  );
}

/*
  `border-border-input` rather than `border-border`.

  The old border measured 1.24:1 against the card behind it. WCAG 1.4.11 asks for 3:1 on the
  visual information that identifies a control, and for a text field that information is the
  outline — there is nothing else. At 1.24:1 the form was, to a low-vision user, a page with
  some words on it. `border-border` stays as it was for card edges and table rules, which are
  decoration and exempt.
*/
const fieldBase =
  'w-full rounded-md border border-border-input bg-background-surface px-3.5 py-2.5 text-[0.9375rem] text-text-primary placeholder:text-text-muted transition-[box-shadow,border-color] duration-150 focus:outline-none focus:border-ring focus:ring-4 focus:ring-ring/15 disabled:opacity-60 disabled:cursor-not-allowed';

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-[0.8125rem] font-medium text-text-secondary"
    >
      {children}
    </label>
  );
}

/**
 * The id a field is known by: the caller's, or one made up for it.
 *
 * Every field linked its label with `htmlFor={id}`, and most callers never passed an id - so
 * the label was attached to nothing. A screen reader announced an unnamed dropdown, clicking
 * a label did not focus its field, and each hint got the id `undefined-hint`, the same one on
 * every field of the page. Found while testing the booking-fee editor, where no field had an
 * id; the same was true of forms across all three apps. A generated id fixes every caller at
 * once, and a caller that does pass an id keeps it.
 */
function useFieldId(id: string | undefined): string {
  const generated = useId();
  return id ?? generated;
}

export function Input({
  label,
  id,
  error,
  hint,
  icon: Icon,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
  hint?: string;
  icon?: LucideIcon;
}) {
  const fieldId = useFieldId(id);
  return (
    <div>
      {label && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}
      <div className="relative">
        {Icon && (
          <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        )}
        <input
          id={fieldId}
          aria-describedby={hint && !error ? `${fieldId}-hint` : undefined}
          className={`${fieldBase} ${Icon ? 'pl-10' : ''} ${error ? 'border-status-error focus:border-status-error focus:ring-status-error/15' : ''} ${className}`}
          aria-invalid={!!error}
          {...props}
        />
      </div>
      {hint && !error && (
        <p id={`${fieldId}-hint`} className="mt-1.5 text-caption text-text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-caption text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function Textarea({
  label,
  id,
  error,
  hint,
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  error?: string;
  /** Matches `Input` and `Select`. A box whose contents have consequences needs to say so. */
  hint?: string;
}) {
  const fieldId = useFieldId(id);
  return (
    <div>
      {label && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}
      <textarea
        id={fieldId}
        aria-describedby={hint && !error ? `${fieldId}-hint` : undefined}
        className={`${fieldBase} ${className}`}
        aria-invalid={!!error}
        {...props}
      />
      {hint && !error && (
        <p id={`${fieldId}-hint`} className="mt-1.5 text-caption text-text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-caption text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function Select({
  label,
  id,
  error,
  hint,
  children,
  className = '',
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  error?: string;
  /** Matches `Input`. A dropdown whose choice has consequences needs room to say so. */
  hint?: string;
}) {
  const fieldId = useFieldId(id);
  return (
    <div>
      {label && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}
      <div className="relative">
        <select
          id={fieldId}
          aria-describedby={hint && !error ? `${fieldId}-hint` : undefined}
          className={`${fieldBase} cursor-pointer appearance-none pr-10 ${className}`}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
      </div>
      {hint && !error && (
        <p id={`${fieldId}-hint`} className="mt-1.5 text-caption text-text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-caption text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}

const cardPadding = { none: '', sm: 'p-4', md: 'p-5', lg: 'p-6' };

/**
 * A white card on the canvas: hairline border, the radius of the context (14px in a console,
 * 20px on the storefront) and at most a very soft shadow.
 *
 * `padding` defaults to the 24px every existing card has; the console design's 16-20px is
 * `md` / `sm`. `interactive` lifts it one elevation step on hover - only for a card that IS a
 * link or opens something, never as decoration.
 */
export function Card({
  children,
  className = '',
  title,
  action,
  interactive,
  padding = 'lg',
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
  interactive?: boolean;
  padding?: keyof typeof cardPadding;
}) {
  return (
    <div
      className={`rounded-lg border border-border bg-background-surface shadow-sm ${cardPadding[padding]} ${
        interactive
          ? 'transition-[transform,box-shadow] duration-150 ease-premium hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0'
          : ''
      } ${className}`}
    >
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-title font-semibold text-text-primary">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/*
  Not `Record<string, string>`.

  Typed that way, `BadgeTone` was `string` and every misspelling compiled: `tone="danger"` -
  there is no danger tone, the one that exists is `error` - produced a badge with no background
  and no colour at all. Two of those shipped, on an organizer's standing and on a ticket admitted
  by eye, and a status badge that renders as plain text is exactly as useful as no badge.

  Keyed to its own literals, the union is the real set of tones and a wrong one will not build.
*/
const badgeTone = {
  /*
    Opaque tints, never `bg-status-warning/12`.

    A 12% wash takes its contrast from whatever is behind the badge, so the same badge
    measured 4.50:1 on a white card and 4.12:1 on a tinted section — and a status badge is
    read at a glance or not at all. `bg-tint-*` is a solid colour whose ratio against its
    own foreground is fixed and asserted in `token-contrast.test.ts`.
  */
  success: 'bg-tint-success text-status-success',
  warning: 'bg-tint-warning text-status-warning',
  error: 'bg-tint-error text-status-error',
  info: 'bg-tint-info text-status-info',
  neutral: 'bg-background-subtle text-text-secondary',
};
export type BadgeTone = keyof typeof badgeTone;

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-caption font-medium ${badgeTone[tone]}`}
    >
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, BadgeTone> = {
  CONFIRMED: 'success',
  ACTIVE: 'success',
  APPROVED: 'success',
  PUBLISHED: 'success',
  COMPLETED: 'success',
  PAID: 'success',
  SUCCEEDED: 'success',
  CHECKED_IN: 'info',
  PROCESSING: 'info',
  SCHEDULED: 'info',
  UNDER_REVIEW: 'warning',
  PENDING: 'warning',
  PENDING_PAYMENT: 'warning',
  REQUESTED: 'warning',
  DRAFT: 'neutral',
  PAUSED: 'warning',
  PARTIALLY_REFUNDED: 'warning',
  REFUNDED: 'error',
  CANCELLED: 'error',
  REJECTED: 'error',
  FAILED: 'error',
  VOID: 'error',
  EXPIRED: 'neutral',
  SOLD_OUT: 'warning',
};

const TONE_DOT: Record<BadgeTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
  neutral: 'bg-text-muted',
};

/**
 * Status pill with a colour dot AND text label (never colour alone).
 *
 * `label` is the status in the reader's language. Without one the pill spells out the enum in
 * English, which is what French storefront pages showed on QA ("PENDING PAYMENT", "REFUNDED").
 * Optional, so the English-only organizer and admin consoles render exactly as before; the
 * colour still follows `status`, never the label.
 */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = STATUS_TONES[status] ?? 'neutral';
  return (
    <Badge tone={tone}>
      <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
      {label ?? titleCase(status)}
    </Badge>
  );
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-action-primary ${className}`} aria-hidden />;
}

/**
 * A grey placeholder in the shape of what is loading. Decorative: the region that is loading
 * says so (`role="status"` + `aria-busy`), not each bar. The pulse stops for anyone who has
 * asked for reduced motion.
 */
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`rounded-md bg-background-subtle motion-safe:animate-pulse ${className}`}
    />
  );
}

/** Lines of text loading: full width, with a shorter last line, as a paragraph looks. */
export function SkeletonText({
  lines = 3,
  className = '',
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div aria-hidden className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={`h-3.5 ${i === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full'}`}
        />
      ))}
    </div>
  );
}

/**
 * A card loading, in the shape of the two cards the consoles show most: a stat card (`stat`:
 * icon tile, label, big number) and an event card (`media`: 16:9 artwork, title, two rows and
 * a meter). `label` names the loading region for assistive technology.
 */
export function SkeletonCard({
  variant = 'stat',
  label = 'Loading',
  className = '',
}: {
  variant?: 'stat' | 'media';
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={`rounded-lg border border-border bg-background-surface ${variant === 'media' ? 'overflow-hidden' : 'p-5'} ${className}`}
    >
      {variant === 'stat' ? (
        <div className="flex items-start gap-4">
          <Skeleton className="h-12 w-12 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2.5 pt-0.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      ) : (
        <>
          <Skeleton className="aspect-video w-full rounded-none" />
          <div className="space-y-2.5 p-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="mt-3 h-1.5 w-full rounded-full" />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Nothing here yet: what this place is for and the one thing to do about it.
 *
 * `tone` puts the icon on a pastel tile (the console look); without it the icon sits on the
 * neutral circle the storefront has always used. `secondaryAction` is a quieter second way on
 * ("Learn how seat maps work"), never a second primary button. `compact` is for an empty
 * section inside a card, where 48px of padding would be most of the card.
 */
export function EmptyState({
  title,
  hint,
  action,
  secondaryAction,
  icon: Icon,
  tone,
  compact = false,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  icon?: LucideIcon;
  tone?: TileTone;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border border-dashed border-border bg-background-surface/50 text-center ${compact ? 'px-6 py-8' : 'p-12'}`}
    >
      {Icon && (
        <div
          aria-hidden
          className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center ${
            tone
              ? `rounded-lg ${tileClasses(tone)}`
              : 'rounded-full bg-background-subtle text-text-muted'
          }`}
        >
          <Icon className="h-6 w-6" />
        </div>
      )}
      <p className="font-semibold text-text-primary">{title}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-sm text-[0.9375rem] text-text-muted">{hint}</p>}
      {(action || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  message: string;
  onRetry?: () => void;
  /** The retry button's words; English unless the app passes its translation. */
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-status-error/30 bg-status-error/5 p-8 text-center"
    >
      <XCircle className="mx-auto mb-3 h-8 w-8 text-status-error" />
      <p className="font-medium text-status-error">{message}</p>
      {onRetry && (
        <Button variant="outline" className="mt-4" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

// ─── DataTable ───

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  /** Enable click-to-sort on this column's header. Sorts by `sortValue` (or the raw render). */
  sortable?: boolean;
  /** Value used for sorting when `sortable` — return a string or number. */
  sortValue?: (row: T) => string | number;
  /** The label in the phone card layout (`mobile="cards"`), when `header` is not words. */
  mobileLabel?: ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  loading,
  empty,
  error,
  onRetry,
  onRowClick,
  rowKey,
  stickyHeader = false,
  density = 'comfortable',
  mobile = 'scroll',
  caption,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  empty?: ReactNode;
  /** When set, renders an ErrorState instead of the table (use for query.isError). */
  error?: string;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  rowKey: (row: T) => string;
  /**
   * Keep the header row in view while a long table scrolls. The table then scrolls inside its
   * own box, capped at 70% of the window - so use it for a list that is the page's main
   * subject, not for a short table in the middle of a page, which should just flow.
   */
  stickyHeader?: boolean;
  /** `compact` for dense admin queues (44px rows); `comfortable` (52px) everywhere else. */
  density?: 'comfortable' | 'compact';
  /**
   * What happens below `sm`. `scroll` (the default) keeps the table and lets it scroll
   * sideways; `cards` shows each row as a card of label / value pairs instead, which reads
   * far better on a phone for a list of more than three columns. The first column is the
   * card's title and keeps the row's control.
   */
  mobile?: 'scroll' | 'cards';
  /** A visually hidden caption naming the table for assistive technology. */
  caption?: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  if (error) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }
  if (loading) {
    /*
      `role="status"`, not a bare div.

      ARIA forbids an accessible name on an element with no role, so `aria-label` on a plain
      `<div>` is DISCARDED — the label was written, looked right in the source, and announced
      nothing. A loading state is the one moment a screen-reader user most needs to be told
      something is happening, and this was silent. `status` both permits the name and
      announces it politely, without interrupting whatever is being read.
    */
    return (
      <div className="space-y-2.5" role="status" aria-busy="true" aria-label="Loading">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }
  if (!rows || rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing to show" />}</>;
  }

  const sortCol = sort && columns.find((c) => c.key === sort.key);
  const sorted =
    sortCol && sortCol.sortable
      ? [...rows].sort((a, b) => {
          const va = sortCol.sortValue ? sortCol.sortValue(a) : '';
          const vb = sortCol.sortValue ? sortCol.sortValue(b) : '';
          const cmp =
            typeof va === 'number' && typeof vb === 'number'
              ? va - vb
              : String(va).localeCompare(String(vb));
          return sort!.dir === 'asc' ? cmp : -cmp;
        })
      : rows;

  const toggleSort = (key: string) =>
    setSort((s) =>
      s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' },
    );

  const cellY = density === 'compact' ? 'py-2.5' : 'py-3.5';

  /*
    The first cell carries the row's control, when the row has one.

    A keyboard user needs SOMETHING to press, and it cannot be the row: a row that opens a page
    and also contains Edit and Approve buttons announces as a button containing buttons, and
    has no accessible name beyond its own contents read aloud in full.

    Wrapping the first cell instead gives the action a real name — "Sunburn Arena — Bengaluru",
    which is what the cell already says — and leaves the other controls in the row as siblings
    rather than descendants. The row keeps its own `onClick` for mouse users, so nothing
    changes for them.

    The first column must therefore not itself be interactive. The accessibility sweep fails
    on `nested-interactive` if one ever becomes so.
  */
  const firstCell = (row: T, c: Column<T>) =>
    onRowClick ? (
      <button
        type="button"
        onClick={(e) => {
          // The row's own handler would otherwise fire a second time.
          e.stopPropagation();
          onRowClick(row);
        }}
        className={`-m-1 block w-full rounded p-1 text-left ${focus}`}
      >
        {c.render(row)}
      </button>
    ) : (
      c.render(row)
    );

  const table = (
    /*
      Reachable by keyboard, because it scrolls.

      The table has a floor, so on a narrow screen — or a wide one once a column holds long
      invited emails — this box scrolls sideways. A table with no clickable rows has nothing
      inside that takes focus, which left a keyboard user no way to scroll it at all: the
      organizer team page failed WCAG 2.1.1 in the accessibility sweep as soon as its member
      list grew. One tab stop on the box lets the arrow keys scroll it.
    */
    <div
      tabIndex={0}
      className={`overflow-x-auto rounded-lg border border-border bg-background-surface shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
        stickyHeader ? 'max-h-[70vh] overflow-y-auto' : ''
      } ${mobile === 'cards' ? 'hidden sm:block' : ''}`}
    >
      {/*
        ── THE FLOOR IS FOR PHONES, NOT FOR DESKTOPS ────────────────────────────────
        A 640px floor on every table meant admin screens scrolled sideways on a laptop the
        moment a column held a sentence - the reconciliation queue cut its first column in
        half, and reading a row meant dragging a scrollbar. The floor still exists so a
        table does not collapse into columns one word wide on a phone, but it is well under
        a phone's width, and cells wrap instead of forcing the table wider.
      */}
      <table className="w-full min-w-[22rem] text-left text-[0.9375rem]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className={stickyHeader ? 'sticky top-0 z-[1]' : ''}>
          <tr className="border-b border-border bg-background-subtle">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const SortIcon = active
                ? sort!.dir === 'asc'
                  ? ChevronUp
                  : ChevronDown
                : ChevronsUpDown;
              return (
                <th
                  key={c.key}
                  aria-sort={
                    active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={`h-11 whitespace-nowrap px-5 text-micro font-semibold uppercase tracking-[0.06em] text-text-muted ${c.className ?? ''}`}
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={`-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-text-primary ${focus}`}
                    >
                      {c.header}
                      <SortIcon
                        className={`h-3.5 w-3.5 ${active ? 'text-text-secondary' : 'text-text-muted/60'}`}
                        aria-hidden
                      />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              /*
                A clickable row is a MOUSE convenience, and is not exposed as a control.

                It used to carry `role="button"` and `tabIndex={0}`. Rows contain their own
                buttons and links — Edit, Approve, a link to the detail page — so that made
                every row a button containing buttons: `nested-interactive`, WCAG 4.1.2. The
                keyboard and assistive-technology path is the real control inside the row
                (see `firstCell`), and the row keeps `onClick` for people using a mouse.
              */
              className={`border-b border-border/70 transition-colors last:border-0 ${
                onRowClick ? 'cursor-pointer hover:bg-background-subtle/60' : ''
              }`}
            >
              {columns.map((c, i) => (
                <td key={c.key} className={`px-5 ${cellY} text-text-primary ${c.className ?? ''}`}>
                  {i === 0 ? firstCell(row, c) : c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (mobile !== 'cards') return table;

  const [head, ...rest] = columns;
  return (
    <>
      {table}
      {/*
        The phone layout: one card per row, the first column as its title and every other
        column as a label / value pair. Sorting stays a desktop affordance - the order the rows
        arrive in is the order a phone shows.
      */}
      <ul className="space-y-3 sm:hidden" aria-label={caption}>
        {sorted.map((row) => (
          <li
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`rounded-lg border border-border bg-background-surface p-4 shadow-xs ${
              onRowClick ? 'cursor-pointer' : ''
            }`}
          >
            <div className="font-semibold text-text-primary">{firstCell(row, head)}</div>
            {rest.length > 0 && (
              <dl className="mt-3 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-ui">
                {rest.map((c) => (
                  <div key={c.key} className="contents">
                    <dt className="text-text-muted">{c.mobileLabel ?? c.header}</dt>
                    <dd className="min-w-0 text-right text-text-primary">{c.render(row)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-4">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </Button>
      <span className="text-[0.9375rem] text-text-muted">
        Page {page} of {totalPages}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  onSubmit,
  placeholder = 'Search…',
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
}) {
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
      role="search"
    >
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          type="search"
          aria-label={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`${fieldBase} pl-10`}
        />
      </div>
      <Button type="submit" variant="outline">
        Search
      </Button>
    </form>
  );
}

/** Star rating — read-only display or interactive input. */
export function RatingStars({
  value,
  onChange,
  size = 'md',
  label,
  valueLabel = (v) => `${v} out of 5`,
  starLabel = (n) => `${n} star${n > 1 ? 's' : ''}`,
}: {
  value: number;
  onChange?: (value: number) => void;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  /** Accessible name when no `label` is given, e.g. "4 out of 5". English by default. */
  valueLabel?: (value: number) => string;
  /** Accessible name of each star button, e.g. "3 stars". English by default. */
  starLabel?: (n: number) => string;
}) {
  const dim = size === 'lg' ? 'h-7 w-7' : size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5';
  const interactive = !!onChange;
  return (
    <div
      className="flex items-center gap-0.5"
      role={interactive ? 'group' : 'img'}
      aria-label={label ?? valueLabel(value)}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = value >= n;
        const star = (
          <Star
            className={`${dim} ${filled ? 'fill-status-warning text-status-warning' : 'text-border-strong'}`}
          />
        );
        return interactive ? (
          <button
            key={n}
            type="button"
            aria-label={starLabel(n)}
            aria-pressed={value >= n}
            onClick={() => onChange!(n)}
            className="transition-transform hover:scale-110"
          >
            {star}
          </button>
        ) : (
          <span key={n}>{star}</span>
        );
      })}
    </div>
  );
}

/** Horizontal step indicator for multi-step flows (e.g. booking). */
export function Stepper({
  steps,
  current,
  label = 'Progress',
}: {
  steps: string[];
  current: number;
  /** The list's accessible name; English unless the app passes its translation. */
  label?: string;
}) {
  return (
    <ol className="flex items-center" aria-label={label}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex items-center gap-2">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-caption font-semibold transition-colors ${
                  done
                    ? 'bg-action-primary text-action-primary-foreground'
                    : active
                      ? 'bg-tint-primary text-action-primary ring-2 ring-action-primary/30'
                      : 'bg-background-subtle text-text-muted'
                }`}
                aria-current={active ? 'step' : undefined}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={`hidden whitespace-nowrap text-caption sm:inline ${
                  active ? 'font-semibold text-text-primary' : 'text-text-muted'
                }`}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span className={`mx-2 h-px flex-1 ${done ? 'bg-action-primary/40' : 'bg-border'}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  tone = 'neutral',
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: BadgeTone;
  icon?: LucideIcon;
}) {
  const accent: Record<BadgeTone, string> = {
    success: 'text-status-success',
    warning: 'text-status-warning',
    error: 'text-status-error',
    info: 'text-status-info',
    neutral: 'text-text-primary',
  };
  return (
    <div className="rounded-lg border border-border bg-background-surface p-5 shadow-sm transition-shadow duration-200 hover:shadow-md">
      <div className="flex items-center justify-between">
        <p className="text-[0.9375rem] text-text-muted">{label}</p>
        {Icon && (
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-full bg-background-subtle ${accent[tone]}`}
          >
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <p className={`mt-2 text-h3 font-bold tracking-tight ${accent[tone]}`}>{value}</p>
      {hint && <p className="mt-1 text-caption text-text-muted">{hint}</p>}
    </div>
  );
}

// ─── Dialog / Drawer (Framer Motion) ───

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One sentence under the title saying what the dialog is for. Read out with its name. */
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * How wide the panel is.
   *
   * Almost every dialog is a confirmation or a short form and `md` is right for those —
   * narrow keeps a question readable. `lg` exists for the few that are genuinely a working
   * surface rather than a prompt: the run scheduler lays out days, times and a conflict list
   * side by side, and at `md` the day chips wrapped mid-week and the preview needed
   * scrolling to read at all.
   */
  size?: 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const onPanelKeyDown = useModalFocus(open, onClose, panelRef);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            className={`flex max-h-[90vh] w-full flex-col rounded-2xl border border-border bg-background-elevated p-6 shadow-lg focus:outline-none ${
              size === 'lg' ? 'max-w-2xl' : 'max-w-md'
            }`}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <h2 className="shrink-0 font-display text-title font-semibold text-text-primary">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 shrink-0 text-ui text-text-secondary">
                {description}
              </p>
            )}
            <div className="mt-3 flex-1 overflow-y-auto text-[0.9375rem] text-text-secondary">
              {children}
            </div>
            {footer && <div className="mt-6 flex shrink-0 justify-end gap-2">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * `Modal` is `Dialog`. The design calls it a modal, the code has always called it a dialog,
 * and two components for one thing is how they drift apart - so it is one, by both names.
 */
export const Modal = Dialog;

/**
 * Focus for anything modal: Escape closes; focus moves in on open (the first control, or the
 * panel); Tab and Shift+Tab stay inside; and focus goes back to whatever opened it on close.
 * Returns the panel's keydown handler.
 */
function useModalFocus(
  open: boolean,
  onClose: () => void,
  panelRef: React.RefObject<HTMLElement | null>,
) {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panel).focus();
    }
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open, panelRef]);

  return (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
    );
    if (focusable.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === panel) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

/**
 * A panel from the side: quick look at a booking, an event's details, a filter set.
 *
 * Modal, like `Dialog`: Escape closes, focus moves in and stays in, and returns to the control
 * that opened it. The header (title, optional description, close) and the `footer` (its
 * actions) stay put while the body scrolls, so a long booking never pushes Refund off screen.
 * Full width on a phone; `md` 448px or `lg` 640px from `sm` up.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeLabel = 'Close',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
  /** The close button's accessible name; English unless the app passes its translation. */
  closeLabel?: string;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const descriptionId = useId();
  const onPanelKeyDown = useModalFocus(open, onClose, panelRef);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            className={`flex h-full w-full flex-col border-l border-border bg-background-elevated shadow-lg focus:outline-none ${
              size === 'lg' ? 'sm:max-w-xl' : 'sm:max-w-md'
            }`}
            onClick={(e) => e.stopPropagation()}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-6 py-4">
              <div className="min-w-0">
                <h2 className="font-display text-title font-semibold text-text-primary">{title}</h2>
                {description && (
                  <p id={descriptionId} className="mt-0.5 text-ui text-text-secondary">
                    {description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={closeLabel}
                className={`-mr-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-background-subtle hover:text-text-primary ${focus}`}
              >
                <X className="h-[1.125rem] w-[1.125rem]" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
            {footer && (
              <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-6 py-4">
                {footer}
              </div>
            )}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Toasts ───

interface Toast {
  id: number;
  message: string;
  tone: BadgeTone;
}
const TOAST_ICON: Record<BadgeTone, LucideIcon> = {
  success: CheckCircle2,
  warning: TriangleAlert,
  error: XCircle,
  info: Info,
  neutral: Info,
};
const TOAST_ACCENT: Record<BadgeTone, string> = {
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
  info: 'text-status-info',
  neutral: 'text-text-muted',
};

const ToastContext = createContext<{ push: (message: string, tone?: BadgeTone) => void } | null>(
  null,
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: BadgeTone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-5 right-5 z-[100] flex flex-col gap-2.5"
        aria-live="polite"
      >
        <AnimatePresence>
          {toasts.map((t) => {
            const Icon = TOAST_ICON[t.tone];
            return (
              <motion.div
                key={t.id}
                role="status"
                className="pointer-events-auto flex items-center gap-3 rounded-md border border-border bg-background-elevated px-4 py-3 text-[0.9375rem] text-text-primary shadow-lg"
                initial={{ opacity: 0, x: 24, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, scale: 0.96 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              >
                <Icon className={`h-5 w-5 shrink-0 ${TOAST_ACCENT[t.tone]}`} />
                {t.message}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  return ctx ?? { push: () => undefined };
}

/**
 * Initials for an avatar, from a name if there is one and the email local-part otherwise.
 *
 * Separated from the component so the edges are testable: a single name, a name with a
 * middle name, an email-only account, and the empty case that must not render "undefined"
 * into the corner of every page.
 */
export function initialsOf(name: string | undefined, email: string | undefined): string {
  const source = (name ?? '').trim() || (email ?? '').split('@')[0] || '';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  // First and LAST, so "Ravi Kumar Iyer" is RI rather than RK.
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
