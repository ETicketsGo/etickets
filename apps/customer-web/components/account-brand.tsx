'use client';

import { useId, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { BRAND_FOCUS, BrandButton, BrandStatusPill, type BrandStatus } from '@eticketsgo/web-kit';
import { BRAND_FIELD } from './booking-brand';
import { BrandPage } from './storefront-brand';

/*
  ── THE ACCOUNT PAGES ON THE BRAND LAYER (docs/design/DESIGN-SYSTEM.md) ─────────────────
  My tickets and one ticket moved to the stage and paper in #400; the rest of the account
  (the index, profile, bookings, a booking's tickets, receipts, saved, following, the inbox
  and its settings, and "Become an organizer") still wore the old system: a grey canvas, blue
  buttons, shadowed white cards and the kit's blue form fields. A buyer went from a paper
  ticket to a grey settings page in one click.

  These are the pieces those pages share and the storefront did not have yet: the page's
  column and heading, a load failure, and labelled form fields and a switch drawn in brand
  tokens. The kit's Input, Select, Textarea and Toggle paint themselves in the old tokens,
  which do not change inside `data-brand`, so the account pages draw their own with the
  same markup contract (a visible label, the hint and the error tied to the field).
*/

const COLUMN_WIDTH = {
  narrow: 'max-w-lg',
  default: 'max-w-2xl',
  wide: 'max-w-5xl',
} as const;

/**
 * An account page: paper to the edges, then a centred column with the shell's gutters.
 *
 * `spaced` puts the page's blocks 32px apart. A page that also renders a drawer or dialog
 * (`position: fixed; inset: 0`) beside its content turns it off and spaces its own column:
 * the gap is a top margin on every later sibling, and it pushed a drawer 32px down, under
 * the site header, on a phone.
 */
export function AccountPage({
  children,
  width = 'default',
  spaced = true,
}: {
  children: ReactNode;
  width?: keyof typeof COLUMN_WIDTH;
  spaced?: boolean;
}) {
  return (
    <BrandPage>
      <div
        className={`mx-auto ${COLUMN_WIDTH[width]} px-4 pt-6 sm:px-6 sm:pt-10 ${spaced ? 'space-y-8' : ''}`}
      >
        {children}
      </div>
    </BrandPage>
  );
}

/** The page's title in the display face, one sentence under it, and an optional action. */
export function AccountHeading({
  title,
  lead,
  action,
}: {
  title: string;
  lead?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-balance font-brand-display text-brand-d2 text-brand-ink">{title}</h1>
        {lead && <p className="mt-2 max-w-prose text-brand-body text-brand-ink-2">{lead}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * Something did not load, and a way to ask again. An alert, as the kit's ErrorState was, so a
 * screen reader hears it without hunting for it; the critical tint carries the words, never
 * the colour alone.
 */
export function BrandError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const tx = useTranslations('common');
  return (
    <div role="alert" className="rounded-brand-card bg-brand-critical-tint px-6 py-8 text-center">
      <p className="text-brand-body font-semibold text-brand-critical">{message}</p>
      {onRetry && (
        <BrandButton variant="secondary" className="mt-4" onClick={onRetry}>
          {tx('action.retry')}
        </BrandButton>
      )}
    </div>
  );
}

/** A flat white panel on the paper: the account pages' card. Never a shadow. */
export const ACCOUNT_PANEL = 'rounded-brand-card border border-brand-line bg-brand-surface';

/** A panel's own heading: the display face at card size. */
export const PANEL_TITLE = 'font-brand-display text-brand-card text-brand-ink';

type FieldProps = {
  label?: string;
  hint?: string;
  error?: string;
};

function useField(id: string | undefined, hint?: string, error?: string) {
  const generated = useId();
  const fieldId = id ?? generated;
  const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined;
  return { fieldId, describedBy };
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-brand-ui font-medium text-brand-ink">
      {children}
    </label>
  );
}

function FieldNotes({ fieldId, hint, error }: { fieldId: string; hint?: string; error?: string }) {
  if (error)
    return (
      <p
        id={`${fieldId}-error`}
        role="alert"
        className="mt-1.5 text-brand-meta text-brand-critical"
      >
        {error}
      </p>
    );
  if (hint)
    return (
      <p id={`${fieldId}-hint`} className="mt-1.5 text-brand-meta text-brand-ink-3">
        {hint}
      </p>
    );
  return null;
}

/** A disabled field reads as fixed text on a sunken ground, not as a box that ignores you. */
const FIELD_DISABLED =
  'disabled:cursor-not-allowed disabled:border-brand-line disabled:bg-brand-sunken disabled:text-brand-ink-2';

/** A labelled text field on the brand layer. Takes every attribute an `<input>` takes. */
export function BrandTextField({
  label,
  hint,
  error,
  id,
  className = '',
  ...props
}: FieldProps & React.InputHTMLAttributes<HTMLInputElement>) {
  const { fieldId, describedBy } = useField(id, hint, error);
  return (
    <div>
      {label && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}
      <input
        id={fieldId}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={`${BRAND_FIELD} w-full ${FIELD_DISABLED} ${
          error ? 'border-brand-critical' : ''
        } ${className}`}
        {...props}
      />
      <FieldNotes fieldId={fieldId} hint={hint} error={error} />
    </div>
  );
}

/** A labelled dropdown on the brand layer, with its own chevron (the native one is removed). */
export function BrandSelectField({
  label,
  hint,
  error,
  id,
  className = '',
  children,
  ...props
}: FieldProps & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { fieldId, describedBy } = useField(id, hint, error);
  return (
    <div>
      {label && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}
      <div className="relative">
        <select
          id={fieldId}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={`${BRAND_FIELD} w-full cursor-pointer appearance-none pr-10 ${FIELD_DISABLED} ${className}`}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-ink-2"
        />
      </div>
      <FieldNotes fieldId={fieldId} hint={hint} error={error} />
    </div>
  );
}

/** A labelled multi-line field. Its own height: `BRAND_FIELD` is a one-line 44px box. */
export function BrandTextareaField({
  label,
  hint,
  error,
  id,
  className = '',
  ...props
}: FieldProps & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { fieldId, describedBy } = useField(id, hint, error);
  return (
    <div>
      {label && <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>}
      <textarea
        id={fieldId}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={`block w-full rounded-brand-control border border-brand-field bg-brand-surface px-3 py-2 text-brand-ui text-brand-ink placeholder:text-brand-ink-3 ${BRAND_FOCUS} ${className}`}
        {...props}
      />
      <FieldNotes fieldId={fieldId} hint={hint} error={error} />
    </div>
  );
}

/**
 * An on/off switch in brand tokens: the kit's Toggle, same markup (a real checkbox with
 * `role="switch"`, visually hidden but in the tab order), redrawn. Off is the field grey,
 * which reaches 3:1 against the paper; on is ink. The knob's position says the state too.
 */
export function BrandToggle({
  checked,
  onChange,
  disabled,
  id,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-center">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        onClick={() => {
          // The drawn track stands in for the input, so a click on it does what a label would.
          if (!disabled) onChange(!checked);
        }}
        className={[
          'relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150',
          'bg-brand-field peer-checked:bg-brand-action',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-brand-focus peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-brand-canvas',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        ].join(' ')}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-brand-surface transition-transform duration-150 ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
    </span>
  );
}

/*
  A record's state (a booking, a ticket, a refund) as the brand's pill. The tones are the kit's
  StatusBadge tones, renamed into the brand's four: success is positive, warning is caution,
  error is critical. Same reading of every status, so a booking is not "green" here and
  "amber" in the drawer it opens.
*/
const STATUS_TONE: Record<string, BrandStatus> = {
  CONFIRMED: 'positive',
  ACTIVE: 'positive',
  APPROVED: 'positive',
  PUBLISHED: 'positive',
  COMPLETED: 'positive',
  PAID: 'positive',
  SUCCEEDED: 'positive',
  CHECKED_IN: 'info',
  PROCESSING: 'info',
  SCHEDULED: 'info',
  UNDER_REVIEW: 'caution',
  PENDING: 'caution',
  PENDING_PAYMENT: 'caution',
  REQUESTED: 'caution',
  PAUSED: 'caution',
  PARTIALLY_REFUNDED: 'caution',
  SOLD_OUT: 'caution',
  REFUNDED: 'critical',
  CANCELLED: 'critical',
  REJECTED: 'critical',
  FAILED: 'critical',
  VOID: 'critical',
};

/** A status in words on the brand's pill. `label` is the status in the reader's language. */
export function AccountStatusPill({ status, label }: { status: string; label: string }) {
  return <BrandStatusPill status={STATUS_TONE[status] ?? 'neutral'}>{label}</BrandStatusPill>;
}
