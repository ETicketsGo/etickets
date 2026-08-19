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
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { titleCase } from './format';

const focus =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas';

const btnBase = `inline-flex items-center justify-center gap-2 rounded-md text-button font-semibold transition-all duration-200 ease-premium active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none ${focus}`;

const sizes = {
  sm: 'h-9 px-3.5',
  md: 'h-11 px-5',
};

const variants = {
  primary:
    'bg-action-primary text-action-primary-foreground shadow-sm hover:bg-action-primary-hover hover:shadow-md',
  secondary: 'bg-action-secondary text-action-secondary-foreground hover:bg-action-secondary/70',
  danger: 'bg-action-danger text-action-danger-foreground shadow-sm hover:brightness-105',
  outline:
    'border border-border bg-background-surface text-text-primary hover:bg-background-subtle hover:border-border-strong',
  ghost: 'text-text-secondary hover:bg-background-subtle hover:text-text-primary',
};
export type ButtonVariant = keyof typeof variants;

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: keyof typeof sizes;
  loading?: boolean;
}) {
  return (
    <button
      className={`${btnBase} ${sizes[size]} ${variants[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  className = '',
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: keyof typeof sizes;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`${btnBase} ${sizes[size]} ${variants[variant]} ${className}`}>
      {children}
    </Link>
  );
}

const fieldBase =
  'w-full rounded-md border border-border bg-background-surface px-3.5 py-2.5 text-[0.9375rem] text-text-primary placeholder:text-text-muted transition-[box-shadow,border-color] duration-150 focus:outline-none focus:border-ring focus:ring-4 focus:ring-ring/15 disabled:opacity-60 disabled:cursor-not-allowed';

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
  return (
    <div>
      {label && <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      <div className="relative">
        {Icon && (
          <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        )}
        <input
          id={id}
          className={`${fieldBase} ${Icon ? 'pl-10' : ''} ${error ? 'border-status-error focus:border-status-error focus:ring-status-error/15' : ''} ${className}`}
          aria-invalid={!!error}
          {...props}
        />
      </div>
      {hint && !error && <p className="mt-1.5 text-caption text-text-muted">{hint}</p>}
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
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; error?: string }) {
  return (
    <div>
      {label && <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      <textarea id={id} className={`${fieldBase} ${className}`} aria-invalid={!!error} {...props} />
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
  children,
  className = '',
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: string; error?: string }) {
  return (
    <div>
      {label && <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      <div className="relative">
        <select
          id={id}
          className={`${fieldBase} cursor-pointer appearance-none pr-10 ${className}`}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-caption text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function Card({
  children,
  className = '',
  title,
  action,
  interactive,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
  interactive?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border border-border bg-background-surface p-6 shadow-sm ${
        interactive
          ? 'transition-all duration-200 ease-premium hover:-translate-y-0.5 hover:shadow-md'
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

const badgeTone: Record<string, string> = {
  success: 'bg-status-success/12 text-status-success',
  warning: 'bg-status-warning/12 text-status-warning',
  error: 'bg-status-error/12 text-status-error',
  info: 'bg-status-info/12 text-status-info',
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

/** Status pill with a colour dot AND text label (never colour alone). */
export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONES[status] ?? 'neutral';
  return (
    <Badge tone={tone}>
      <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} aria-hidden />
      {titleCase(status)}
    </Badge>
  );
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <Loader2 className={`animate-spin text-action-primary ${className}`} aria-hidden />;
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-background-subtle ${className}`} />;
}

export function EmptyState({
  title,
  hint,
  action,
  icon: Icon,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-background-surface/50 p-12 text-center">
      {Icon && (
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-background-subtle text-text-muted">
          <Icon className="h-6 w-6" />
        </div>
      )}
      <p className="font-semibold text-text-primary">{title}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-sm text-[0.9375rem] text-text-muted">{hint}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-status-error/30 bg-status-error/5 p-8 text-center"
    >
      <XCircle className="mx-auto mb-3 h-8 w-8 text-status-error" />
      <p className="font-medium text-status-error">{message}</p>
      {onRetry && (
        <Button variant="outline" className="mt-4" onClick={onRetry}>
          Try again
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
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  if (error) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }
  if (loading) {
    return (
      <div className="space-y-2.5" aria-busy="true" aria-label="Loading">
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

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-background-surface shadow-sm">
      <table className="w-full min-w-[640px] text-left text-[0.9375rem]">
        <thead>
          <tr className="border-b border-border">
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
                  className={`px-5 py-3.5 text-caption font-semibold uppercase tracking-wide text-text-muted ${c.className ?? ''}`}
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={`-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-text-secondary ${focus}`}
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
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              role={onRowClick ? 'button' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              className={`border-b border-border/70 last:border-0 transition-colors ${
                onRowClick
                  ? `cursor-pointer hover:bg-background-subtle/60 focus-visible:bg-background-subtle/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50`
                  : ''
              }`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`px-5 py-4 text-text-primary ${c.className ?? ''}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
}: {
  value: number;
  onChange?: (value: number) => void;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}) {
  const dim = size === 'lg' ? 'h-7 w-7' : size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5';
  const interactive = !!onChange;
  return (
    <div
      className="flex items-center gap-0.5"
      role={interactive ? 'group' : 'img'}
      aria-label={label ?? `${value} out of 5`}
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
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
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
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center" aria-label="Progress">
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
                      ? 'bg-action-primary/15 text-action-primary ring-2 ring-action-primary/30'
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
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus management: remember the trigger, move focus into the dialog on open,
  // and restore focus to the trigger on close/unmount (accessibility).
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
  }, [open]);

  // Trap Tab / Shift+Tab within the panel so focus can't reach the page behind.
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
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
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            className="flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-border bg-background-elevated p-6 shadow-lg focus:outline-none"
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <h2 className="shrink-0 text-title font-semibold text-text-primary">{title}</h2>
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

export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="h-full w-full max-w-md overflow-y-auto border-l border-border bg-background-elevated p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-title font-semibold text-text-primary">{title}</h2>
              <button
                onClick={onClose}
                aria-label="Close"
                className={`rounded-full p-1.5 text-text-muted hover:bg-background-subtle hover:text-text-primary ${focus}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {children}
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
