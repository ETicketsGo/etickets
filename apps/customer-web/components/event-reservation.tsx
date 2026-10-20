'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { BRAND_EYEBROW, QuantityStepper } from '@/components/booking-brand';

/*
  ── THE RESERVATION CARD'S TICKET CHOICE ──────────────────────────────────────────────
  The owner's event-page design (2026-10-19): ticket types as radio rows with their price, then
  ONE guest stepper, then the breakdown. It replaces a stepper on every row.

  What a buyer can do is unchanged, and that is the hard part. The old rows let somebody take
  two General and one VIP in one order, and the booking, the quote and the e2e suite all rely on
  it. So the radio chooses which ticket the stepper counts, and every count is kept:
    - choose General, press + twice: 2 General;
    - choose VIP, press + once: 2 General and 1 VIP, and the General row says "2 chosen".
  The state is the same `qty` record it always was (ticket id -> count), so the quote, the
  saved selection and the booking request are built exactly as before.
*/

export interface ChooserTicket {
  id: string;
  name: string;
  /** Already formatted, with the card's decimals. */
  price: string;
  /** Its availability, as `TicketAvailability` says it. */
  meta: ReactNode;
  /** Sold out, closed or not yet on sale: shown, and not choosable. */
  unavailable: boolean;
  /** The most one order may take. */
  max: number;
}

/** The ticket the stepper counts: the buyer's choice, else one already counted, else the first on sale. */
export function selectedTicketId(
  tickets: ChooserTicket[],
  chosen: string | null,
  qty: Record<string, number>,
): string | null {
  const usable = tickets.filter((t) => !t.unavailable);
  if (chosen && usable.some((t) => t.id === chosen)) return chosen;
  return usable.find((t) => (qty[t.id] ?? 0) > 0)?.id ?? usable[0]?.id ?? null;
}

export function TicketTypeChooser({
  name,
  tickets,
  selectedId,
  qty,
  onSelect,
  onQuantity,
}: {
  /** The radio group's form name; unique on the page. */
  name: string;
  tickets: ChooserTicket[];
  selectedId: string | null;
  qty: Record<string, number>;
  onSelect: (id: string) => void;
  onQuantity: (id: string, count: number) => void;
}) {
  const t = useTranslations('storefront.event');
  const tx = useTranslations('common');
  const selected = tickets.find((ticket) => ticket.id === selectedId) ?? null;
  return (
    <div>
      <fieldset data-testid="ticket-selection">
        <legend className="sr-only">{t('ticketTypeLegend')}</legend>
        <ul className="divide-y divide-brand-line border-b border-brand-line">
          {tickets.map((ticket) => {
            const count = qty[ticket.id] ?? 0;
            const isSelected = ticket.id === selectedId;
            return (
              <li key={ticket.id}>
                <label
                  className={`flex gap-3 py-4 ${
                    ticket.unavailable ? 'cursor-not-allowed' : 'cursor-pointer'
                  }`}
                >
                  <input
                    type="radio"
                    name={name}
                    value={ticket.id}
                    checked={isSelected}
                    disabled={ticket.unavailable}
                    onChange={() => onSelect(ticket.id)}
                    className="mt-1 h-4 w-4 shrink-0 cursor-[inherit] accent-brand-ink"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span
                        className={`font-brand-display text-brand-card ${
                          ticket.unavailable ? 'text-brand-ink-2' : 'text-brand-ink'
                        }`}
                      >
                        {ticket.name}
                      </span>
                      <span className="shrink-0 font-brand-display text-brand-card tabular-nums text-brand-ink">
                        {ticket.price}
                      </span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {ticket.meta}
                      {/* A count on a row the stepper is not showing, so nothing chosen is hidden. */}
                      {count > 0 && !isSelected ? (
                        <span className="text-brand-meta font-semibold text-brand-ink">
                          {t('chosenCount', { count })}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {selected ? (
        <div className="flex items-center justify-between gap-4 py-4">
          <div className="min-w-0">
            <p className={BRAND_EYEBROW}>{t('guests')}</p>
            <p className="mt-1 truncate text-brand-meta text-brand-ink-2">{selected.name}</p>
          </div>
          <QuantityStepper
            label={tx('a11y.quantityOf', { name: selected.name })}
            name={selected.name}
            value={qty[selected.id] ?? 0}
            max={selected.max}
            disabled={selected.unavailable}
            onChange={(next) => onQuantity(selected.id, next)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** A seated show's prices, read-only: the seats themselves are chosen on the map. */
export function SeatPriceList({
  tickets,
}: {
  tickets: { id: string; name: string; price: string; meta: ReactNode }[];
}) {
  return (
    <ul className="divide-y divide-brand-line border-b border-brand-line">
      {tickets.map((ticket) => (
        <li key={ticket.id} className="py-4">
          <p className="flex items-baseline justify-between gap-3">
            <span className="font-brand-display text-brand-card text-brand-ink">{ticket.name}</span>
            <span className="shrink-0 font-brand-display text-brand-card tabular-nums text-brand-ink">
              {ticket.price}
            </span>
          </p>
          <div className="mt-1">{ticket.meta}</div>
        </li>
      ))}
    </ul>
  );
}
