'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Check, Minus, Plus } from 'lucide-react';
import { BRAND_FOCUS, BrandStatusPill, formatFor } from '@eticketsgo/web-kit';
import { useFormat } from '@/lib/format';

/*
  ── THE BOOKING FLOW'S OWN PIECES ON THE BRAND LAYER ──────────────────────────────────
  docs/design/DESIGN-SYSTEM.md. The event page, the seat page, Review & pay and the
  confirmation all draw the same few things: a flat panel, a quantity stepper, a ticket's
  availability in words, and a show's date in the venue's clock. They live here, once, so the
  four screens cannot drift apart. Kept in the storefront rather than web-kit until the design
  lead decides whether the console needs them too (see the slice's report).

  Every class resolves only inside `data-brand="customer"`, which each page in the flow puts on
  its outermost element.
*/

/** A flat panel on the paper: surface, hairline, the card radius. Never a shadow. */
export const BRAND_PANEL = 'rounded-brand-card border border-brand-line bg-brand-surface';

/** A section label above a group ("Your order"): eyebrow size, caps, quiet ink. */
export const BRAND_EYEBROW = 'text-brand-eyebrow uppercase text-brand-ink-3';

/** A text link on paper: ink, underlined, the brand focus ring. Marigold is never text here. */
export const BRAND_LINK = `rounded-sm font-medium text-brand-ink underline decoration-brand-line-strong underline-offset-4 hover:decoration-brand-ink ${BRAND_FOCUS}`;

/** A text field on the brand layer: 44px, the field outline that reaches 3:1 everywhere. */
export const BRAND_FIELD = `h-11 rounded-brand-control border border-brand-field bg-brand-surface px-3 text-brand-ui text-brand-ink placeholder:text-brand-ink-3 ${BRAND_FOCUS}`;

/**
 * At or below this many left, a ticket says so as a caution pill rather than a quiet count.
 *
 * A count is only urgent when it is small. "1,178 left" is information; "6 left" is a reason to
 * decide now. Twenty is where a family or a group of friends starts to be at risk of not fitting.
 */
export const FEW_LEFT = 20;

/**
 * How many of a ticket, as a minus, a number and a plus - 44px each, for a thumb.
 *
 * ── WHY NOT THE SELECT IT REPLACES ────────────────────────────────────────────────
 * The audit (C4) found the quantity as a small native select reading "0": on a phone it opened a
 * full-screen wheel to choose "2", and its 0 read as a price that failed to load. A stepper is
 * one tap per ticket and shows the count where the eye already is.
 *
 * The group carries the old select's name ("Quantity of Lawn"), so a screen reader hears the same
 * thing it did; each button names its own action and the ticket; the count is announced politely
 * as it changes. `data-quantity-stepper` and `data-step` are the e2e suite's handles.
 */
export function QuantityStepper({
  label,
  name,
  value,
  max,
  disabled = false,
  onChange,
}: {
  /** The group's accessible name: "Quantity of Lawn". */
  label: string;
  /** What is being counted, for the buttons' names. */
  name: string;
  value: number;
  max: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const t = useTranslations('storefront.event');
  const button = `flex h-11 w-11 items-center justify-center rounded-brand-control text-brand-ink transition-colors duration-150 hover:bg-brand-sunken disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${BRAND_FOCUS}`;
  return (
    <div
      role="group"
      aria-label={label}
      data-quantity-stepper
      data-quantity={value}
      className={`inline-flex shrink-0 items-center rounded-brand-control border ${
        disabled ? 'border-brand-line' : 'border-brand-field'
      } bg-brand-surface`}
    >
      <button
        type="button"
        data-step="down"
        aria-label={t('stepperLess', { name })}
        disabled={disabled || value <= 0}
        onClick={() => onChange(Math.max(0, value - 1))}
        className={button}
      >
        <Minus className="h-4 w-4" aria-hidden />
      </button>
      <output
        aria-live="polite"
        className={`w-8 text-center text-brand-body font-semibold tabular-nums ${
          disabled ? 'text-brand-ink-3' : 'text-brand-ink'
        }`}
      >
        {value}
      </output>
      <button
        type="button"
        data-step="up"
        aria-label={t('stepperMore', { name })}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className={button}
      >
        <Plus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/** A ticket's sale state, in words, as the brand's pill or quiet meta text. */
export function TicketAvailability({
  available,
  saleState,
  salesStartAt,
  zone,
}: {
  available: number;
  saleState?: string | null;
  salesStartAt?: string | null;
  zone?: string;
}) {
  const t = useTranslations('storefront.event');
  const tx = useTranslations('common');
  const { dateTime } = useFormat();
  if (saleState === 'CLOSED')
    return <BrandStatusPill status="neutral">{t('salesClosed')}</BrandStatusPill>;
  if (saleState === 'NOT_YET')
    return (
      <span className="text-brand-meta text-brand-ink-2">
        {salesStartAt
          ? t('salesOpenOn', { date: dateTime(salesStartAt, undefined, zone) })
          : t('salesNotOpen')}
      </span>
    );
  if (available <= 0)
    return <BrandStatusPill status="neutral">{tx('state.soldOut')}</BrandStatusPill>;
  if (available <= FEW_LEFT)
    return <BrandStatusPill status="caution">{t('left', { count: available })}</BrandStatusPill>;
  return (
    <span className="text-brand-meta tabular-nums text-brand-ink-3">
      {t('left', { count: available })}
    </span>
  );
}

/**
 * A show's start as the venue reads it, in parts: "Sat 21 Nov 2026", "6:30 pm", "GMT+5:30".
 *
 * The parts are laid out by the caller (the hero sets the day bold and the time beside it). The
 * zone is always the venue's and is always named: a buyer planning a trip from another zone must
 * see whose 6:30 it is (DESIGN-SYSTEM.md section 9).
 */
export function useVenueWhen() {
  const locale = formatFor(useLocale()).locale;
  const { zoneAbbrev } = useFormat();
  return (iso: string, zone: string | undefined) => {
    const at = new Date(iso);
    const opts = zone ? { timeZone: zone } : {};
    let day: string;
    let time: string;
    try {
      day = new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        ...opts,
      })
        .format(at)
        .replace(/,/g, '');
      time = new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit',
        ...opts,
      }).format(at);
    } catch {
      day = at.toDateString();
      time = at.toTimeString().slice(0, 5);
    }
    return { day, time, zone: zone ? zoneAbbrev(iso, zone) : '' };
  };
}

/**
 * Where the buyer is in the purchase: Tickets, Payment, Confirmation, Ticket.
 *
 * The kit's Stepper paints itself in the old blue and shows numbered circles that hide their
 * names on a phone, so a phone saw "1 2 3 4" with no words. This one is words first: every
 * step is named at every width, the current one in ink with `aria-current`, finished ones with
 * a tick, the rest quiet.
 */
export function BrandSteps({ steps, current }: { steps: string[]; current: number }) {
  const tx = useTranslations('common');
  return (
    <ol
      aria-label={tx('a11y.progress')}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-brand-meta"
    >
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              aria-current={active ? 'step' : undefined}
              className={`inline-flex items-center gap-1.5 ${
                active
                  ? 'font-semibold text-brand-ink'
                  : done
                    ? 'text-brand-ink-2'
                    : 'text-brand-ink-3'
              }`}
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
              {step}
            </span>
            {index < steps.length - 1 ? (
              <span aria-hidden className="h-px w-4 bg-brand-line-strong sm:w-8" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
