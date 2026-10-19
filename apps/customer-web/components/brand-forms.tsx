'use client';

import {
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronDown, Loader2, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  BRAND_FOCUS,
  brandButtonClasses,
  type BrandButtonSize,
  type BrandButtonVariant,
  DEFAULT_PASSWORD_FIELD_COPY,
  type PasswordFieldCopy,
} from '@eticketsgo/web-kit';
import {
  PASSWORD_MAX_LENGTH,
  passwordProblems,
  passwordStrength,
  type PasswordContext,
} from '@eticketsgo/shared-types';
import { BRAND_FIELD, BRAND_PANEL } from './booking-brand';
import { BRAND_WRAP, BrandPage } from './storefront-brand';

/*
  ── FORMS, SMALL PAGES AND THEIR STATES ON THE BRAND LAYER ─────────────────────────────
  Sign-in, sign-up, the two password pages, Find my booking, the emailed booking link and the
  handful of short pages around a purchase were the last storefront screens still drawn in the
  old system: a white card on grey, blue buttons, `text-caption` labels. They are forms and
  single-panel pages, so they share the same few pieces - a labelled field, a submit button that
  says it is busy, the Mobile | Email tabs, a centred panel, and the loading and error states.

  Each piece keeps the old component's CONTRACT, not just its look: a field's label is tied to
  its input, its hint is the input's description, an error is `role="alert"` and marks the input
  invalid; a busy button is disabled and `aria-busy`. The forms behind them are unchanged.

  Every class resolves only inside `data-brand="customer"` (BrandPage puts it on the page).
*/

/** The label above a brand field. */
const LABEL = 'mb-1.5 block text-brand-ui font-medium text-brand-ink';
/** A hint or the reason a field was refused, under it. */
const HINT = 'mt-1.5 text-brand-meta text-brand-ink-3';
const ERROR = 'mt-1.5 text-brand-meta font-medium text-brand-critical';
/** A refused field keeps the 3:1 outline, in the critical colour. */
const FIELD_INVALID = 'border-brand-critical';

/** The id a field is known by: the caller's, or one made up for it (as web-kit's fields do). */
function useFieldId(id: string | undefined): string {
  const generated = useId();
  return id ?? generated;
}

/** A labelled text input on paper: web-kit `Input`'s contract with the brand's look. */
export function BrandInput({
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
      {label && (
        <label htmlFor={fieldId} className={LABEL}>
          {label}
        </label>
      )}
      <div className="relative">
        {Icon && (
          <Icon
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-ink-3"
          />
        )}
        <input
          id={fieldId}
          aria-describedby={hint && !error ? `${fieldId}-hint` : undefined}
          aria-invalid={!!error}
          className={`${BRAND_FIELD} w-full ${Icon ? 'pl-9' : ''} ${error ? FIELD_INVALID : ''} ${className}`}
          {...props}
        />
      </div>
      {hint && !error && (
        <p id={`${fieldId}-hint`} className={HINT}>
          {hint}
        </p>
      )}
      {error && (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      )}
    </div>
  );
}

/** A labelled select on paper: web-kit `Select`'s contract with the brand's look. */
export function BrandSelect({
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
  hint?: string;
}) {
  const fieldId = useFieldId(id);
  return (
    <div>
      {label && (
        <label htmlFor={fieldId} className={LABEL}>
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={fieldId}
          aria-describedby={hint && !error ? `${fieldId}-hint` : undefined}
          className={`${BRAND_FIELD} w-full cursor-pointer appearance-none pr-9 ${error ? FIELD_INVALID : ''} ${className}`}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-ink-3"
        />
      </div>
      {hint && !error && (
        <p id={`${fieldId}-hint`} className={HINT}>
          {hint}
        </p>
      )}
      {error && (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      )}
    </div>
  );
}

/** A labelled text area on paper. Height comes from `rows`, so the 44px field height is dropped. */
export function BrandTextarea({
  label,
  id,
  error,
  hint,
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  error?: string;
  hint?: string;
}) {
  const fieldId = useFieldId(id);
  return (
    <div className={className}>
      {label && (
        <label htmlFor={fieldId} className={LABEL}>
          {label}
        </label>
      )}
      <textarea
        id={fieldId}
        aria-describedby={hint && !error ? `${fieldId}-hint` : undefined}
        aria-invalid={!!error}
        className={`${BRAND_FIELD} block h-auto w-full py-2.5 ${error ? FIELD_INVALID : ''}`}
        {...props}
      />
      {hint && !error && (
        <p id={`${fieldId}-hint`} className={HINT}>
          {hint}
        </p>
      )}
      {error && (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A password field that says, while it is typed, whether it will be accepted and why not.
 *
 * web-kit's `PasswordField` on the brand layer. The RULES are not copied: the reading comes from
 * the same `passwordProblems` / `passwordStrength` the server and web-kit use, so this meter can
 * never be kinder than the server either. Only how it is drawn differs.
 */
export function BrandPasswordField({
  id,
  value,
  onChange,
  context,
  copy = DEFAULT_PASSWORD_FIELD_COPY,
  serverError,
  autoComplete = 'new-password',
  required,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  context?: PasswordContext;
  copy?: PasswordFieldCopy;
  serverError?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  const typed = value.length > 0;
  const problems = typed ? passwordProblems(value, context) : [];
  const { score } = passwordStrength(value, context);
  const message = serverError ?? (problems[0] ? copy.problems[problems[0].code] : undefined);
  const statusId = `${id}-strength`;
  // Shape AND colour: the number of filled bars carries the level for anyone who cannot see hue.
  const fill =
    score === 0 ? 'bg-brand-critical' : score === 1 ? 'bg-brand-caution' : 'bg-brand-positive';
  const filled = Math.max(score, 1);

  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {copy.label}
      </label>
      <input
        id={id}
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={PASSWORD_MAX_LENGTH}
        required={required}
        aria-invalid={!!message}
        aria-describedby={typed ? statusId : `${id}-hint`}
        className={`${BRAND_FIELD} w-full ${message ? FIELD_INVALID : ''}`}
      />
      {!typed && (
        <p id={`${id}-hint`} className={HINT}>
          {copy.hint}
        </p>
      )}
      {typed && (
        <div id={statusId} className="mt-2" aria-live="polite">
          <div className="flex gap-1" aria-hidden="true">
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className={`h-1.5 flex-1 rounded-full ${n <= filled ? fill : 'bg-brand-sunken'}`}
              />
            ))}
          </div>
          <p className={HINT} data-testid="password-strength">
            {copy.strength(copy.levels[score])}
          </p>
          {message && (
            <p className={ERROR} data-testid="password-problem">
              {message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A brand button that can say it is busy: disabled, `aria-busy` and a spinner, as web-kit's
 * `Button loading` does. `danger` is the one destructive confirmation ("Yes, cancel it").
 */
export function BrandActionButton({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  type = 'button',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BrandButtonVariant | 'danger';
  size?: BrandButtonSize;
  loading?: boolean;
}) {
  const classes =
    variant === 'danger'
      ? `${brandButtonClasses('primary', size)} !bg-brand-critical hover:!bg-brand-critical/90`
      : brandButtonClasses(variant, size);
  return (
    <button
      type={type}
      className={`${classes} ${className}`}
      disabled={loading || disabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : null}
      {children}
    </button>
  );
}

/**
 * Two or more ways in, as tabs: Mobile | Email. The chosen one is ink on paper with
 * `aria-selected`, so it reads without colour.
 */
export function BrandTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-brand-control bg-brand-sunken p-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={`min-h-11 flex-1 rounded-[0.5rem] px-3 py-1.5 text-brand-ui transition-colors duration-150 ${BRAND_FOCUS} ${
            value === tab.value
              ? 'bg-brand-surface font-semibold text-brand-ink'
              : 'text-brand-ink-2 hover:text-brand-gold-text'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** The grey block the tabs sit on while the sign-in options load (no layout jump). */
export function BrandTabsPlaceholder() {
  return <div className="h-[3.25rem] rounded-brand-control bg-brand-sunken" aria-hidden="true" />;
}

/**
 * A short page on paper: one panel, centred, in a column a form reads well in.
 *
 * Sign-in, password reset, Find my booking and the checkout returns are one decision each, so
 * the page is the panel - no hero, no band. `wide` is for the booking pages, which hold more.
 */
export function BrandCenteredPage({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <BrandPage>
      <div className={`mx-auto px-4 pt-8 sm:px-6 sm:pt-12 ${wide ? 'max-w-lg' : 'max-w-md'}`}>
        {children}
      </div>
    </BrandPage>
  );
}

/** The flat panel a short page's content sits in. */
export function BrandFormPanel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`${BRAND_PANEL} p-5 sm:p-8 ${className}`}>{children}</div>;
}

/** A short page's title, in the display face. */
export const BRAND_PAGE_TITLE = 'text-balance font-brand-display text-brand-d2 text-brand-ink';
/** A short page's lead sentence. */
export const BRAND_LEAD = 'text-brand-body text-brand-ink-2';
/** A quiet line under a form ("No account? Create one"). */
export const BRAND_NOTE = 'text-brand-meta text-brand-ink-3';
/** A form-level refusal under the fields. */
export const BRAND_ALERT = 'text-brand-meta font-medium text-brand-critical';
/** An inset notice inside a panel: a hairline-free sunken block. */
export const BRAND_INSET = 'rounded-brand-control bg-brand-sunken p-4';

/** A block loading, in the brand's sunken tone. */
export function BrandSkeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`rounded-brand-card bg-brand-sunken motion-safe:animate-pulse ${className}`}
    />
  );
}

/**
 * A load that failed, and the retry: web-kit `ErrorState`'s contract (`role="alert"`, the retry
 * in the reader's language) as a quiet block on paper instead of a pink box.
 */
export function BrandLoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const tx = useTranslations('common');
  return (
    <div role="alert" className="rounded-brand-card bg-brand-sunken px-6 py-10 text-center">
      <p className="text-balance font-brand-display text-brand-d3 text-brand-ink">{message}</p>
      {onRetry && (
        <div className="mt-6 flex justify-center">
          <BrandActionButton variant="secondary" onClick={onRetry}>
            {tx('action.retry')}
          </BrandActionButton>
        </div>
      )}
    </div>
  );
}

/**
 * A wide page's loading, failed or empty state on paper: the page's own gutters, the state in
 * them. For the booking pages whose real shell is only drawn once there is data to draw.
 */
export function BrandStatePage({ children }: { children: ReactNode }) {
  return (
    <BrandPage>
      <div className={`${BRAND_WRAP} pt-8 sm:pt-10`}>{children}</div>
    </BrandPage>
  );
}
