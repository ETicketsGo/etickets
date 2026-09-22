'use client';

import { ArrowLeft, CalendarDays, MapPin, Printer } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PrintableTickets, type WalletTicket } from '@eticketsgo/web-kit';
import type { GuestBookingView } from '@/lib/api';
import { Link } from '@/i18n/navigation';
import { useFormat } from '@/lib/format';
import { ButtonLink, Card, StatusBadge } from '@/components/ui';
import { ReferenceCode } from '@/components/reference-code';
import { useStatusLabel } from '@/lib/status-label';

/**
 * A booking as a guest sees it, and the tickets that came with it.
 *
 * ── WHY ONE COMPONENT FOR TWO PAGES ────────────────────────────────────────────────
 * The confirmation screen a guest lands on after paying, and the page their emailed link
 * opens, show the same booking from the same payload. Two renderings of one payload is how a
 * ticket comes to say one thing in the browser and another in the email link -- and this is
 * the screen somebody holds up at the door, so the two must agree.
 *
 * ── WHY NOT `PriceBreakdown` ───────────────────────────────────────────────────────
 * That component itemises fees row by row, and a guest view carries four totals rather than
 * the fee-by-fee detail an account gets. Feeding it numbers it does not have would make it
 * print rows that do not add up to the total, which is the one thing it exists to prevent.
 * The receipt in the buyer's email carries the full detail.
 */
export function GuestBookingSummary({ view }: { view: GuestBookingView }) {
  const g = useTranslations('storefront.guest');
  const c = useTranslations('storefront.confirmation');
  const { money, dateTime } = useFormat();
  const statusLabel = useStatusLabel();

  // A cinema and its screen when there is one; otherwise the venue. Never "null - null".
  const place =
    [view.event.cinemaName, view.event.screenName].filter(Boolean).join(' - ') ||
    view.event.venueName;
  const items = view.items.filter((item) => item.quantity > 0);
  const seatLabels = view.tickets
    .map((ticket) => ticket.seatLabel)
    .filter((label): label is string => Boolean(label));

  return (
    <Card className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <p className="font-semibold text-text-primary">{view.event.title}</p>
          <StatusBadge status={view.status} label={statusLabel('booking', view.status)} />
        </div>
        <p className="flex items-center gap-1.5 text-[0.9375rem] text-text-muted">
          <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
          {dateTime(view.event.startsAt, undefined, view.event.timeZone ?? undefined)}
        </p>
        {place ? (
          <p className="flex items-center gap-1.5 text-[0.9375rem] text-text-muted">
            <MapPin className="h-4 w-4 shrink-0" aria-hidden />
            {place}
          </p>
        ) : null}
      </div>

      {/*
        A reference is assigned when a booking is paid for, so an unpaid one has none. The row
        is left out rather than shown empty: a blank box beside "Booking reference" reads as a
        value that failed to load, and this one is asked for at a counter.
      */}
      {view.reference ? (
        <div className="flex items-center justify-between text-[0.9375rem]">
          <span className="text-text-secondary">{c('bookingReference')}</span>
          <ReferenceCode value={view.reference} label={c('bookingReference')} />
        </div>
      ) : null}

      {items.length > 0 || seatLabels.length > 0 ? (
        <div className="space-y-1.5 border-t border-border pt-3">
          <p className="text-caption font-medium uppercase tracking-wide text-text-muted">
            {c('yourOrder')}
          </p>
          {items.map((item, index) => (
            <div
              key={`${item.label}-${index}`}
              className="flex justify-between gap-4 text-[0.9375rem]"
            >
              <span className="text-text-primary">
                {c('itemLine', { name: item.label, quantity: item.quantity })}
              </span>
              <span className="tabular-nums text-text-secondary">
                {money(item.unitPriceMinor * item.quantity, view.currency)}
              </span>
            </div>
          ))}
          {seatLabels.length > 0 ? (
            <div className="flex justify-between gap-4 text-[0.9375rem]">
              <span className="text-text-secondary">
                {seatLabels.length === 1 ? c('seat') : c('seats')}
              </span>
              <span className="text-right font-medium text-text-primary">
                {seatLabels.join(', ')}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <GuestTotals view={view} />

      <p className="border-t border-border pt-3 text-caption text-text-muted">
        {g('bookedBy', { name: view.buyer.name, email: view.buyer.emailMasked })}
      </p>
    </Card>
  );
}

/** Subtotal, fees, tax and total. Four numbers, all in the currency the booking was priced in. */
export function GuestTotals({ view }: { view: GuestBookingView }) {
  const g = useTranslations('storefront.guest');
  const { money } = useFormat();
  const rows: { label: string; minor: number }[] = [
    { label: g('subtotal'), minor: view.totals.subtotalMinor },
    { label: g('fees'), minor: view.totals.feesMinor },
    { label: g('tax'), minor: view.totals.taxMinor },
  ];

  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      {rows
        // A zero fee row and a zero tax row say nothing; the subtotal is always shown.
        .filter((row, index) => index === 0 || row.minor !== 0)
        .map((row) => (
          <div key={row.label} className="flex justify-between gap-4 text-[0.9375rem]">
            <span className="text-text-secondary">{row.label}</span>
            <span className="tabular-nums text-text-secondary">
              {money(row.minor, view.currency)}
            </span>
          </div>
        ))}
      <div className="flex justify-between gap-4 border-t border-border pt-1.5 text-title font-semibold">
        <span className="text-text-primary">{g('total')}</span>
        <span className="tabular-nums text-text-primary">
          {money(view.totals.totalMinor, view.currency)}
        </span>
      </div>
    </div>
  );
}

/**
 * The QR codes, drawn by the server.
 *
 * A guest cannot use the wallet: `GET /tickets` answers for an account, and there is no
 * account here. The images come with the booking instead, which is also why this page works
 * from an emailed link on a phone that has never signed in to anything.
 */
export function GuestTickets({
  view,
  printHref,
}: {
  view: GuestBookingView;
  /**
   * Where the full-size tickets open: large QR codes, one per page, printable and savable as a
   * PDF. Reported from QA as "I see the confirmation and not a ticket": an account holder can
   * open each ticket on its own, and a guest could not - they had a thumbnail, and a promise
   * that a link was on its way by email. With email not delivering, closing the tab lost the
   * tickets. This gives the guest a ticket they can hold without waiting for anything.
   */
  printHref?: string;
}) {
  const g = useTranslations('storefront.guest');
  const w = useTranslations('storefront.wallet');
  const c = useTranslations('storefront.confirmation');
  const { dateTime } = useFormat();

  if (view.tickets.length === 0) return null;

  return (
    <div className="space-y-3">
      {view.tickets.map((ticket, index) => (
        <Card key={ticket.id} className="flex items-center gap-4">
          {/* A barcode the server cannot draw has no image. Say so in the space it would take. */}
          {ticket.qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ticket.qrDataUrl}
              alt={g('ticketQrAlt', { number: index + 1 })}
              className="h-28 w-28 shrink-0 rounded-md bg-white p-1"
            />
          ) : (
            <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-background-subtle p-2 text-center text-caption text-text-muted">
              {w('qrUnavailable')}
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-semibold text-text-primary">{view.event.title}</p>
            <p className="text-[0.9375rem] text-text-muted">
              {dateTime(view.event.startsAt, undefined, view.event.timeZone ?? undefined)}
            </p>
            {ticket.ticketTypeName ? (
              <p className="text-[0.9375rem] text-text-secondary">{ticket.ticketTypeName}</p>
            ) : null}
            {ticket.seatLabel ? (
              <p className="text-[0.9375rem] text-text-primary">
                {c('seat')} <strong>{ticket.seatLabel}</strong>
              </p>
            ) : null}
            {ticket.checkedInAt ? (
              <p className="text-caption text-text-muted">
                {g('checkedIn', { when: dateTime(ticket.checkedInAt) })}
              </p>
            ) : null}
          </div>
        </Card>
      ))}
      {printHref ? (
        <ButtonLink href={printHref} className="w-full">
          <Printer className="h-4 w-4" aria-hidden />
          {g('openTickets')}
        </ButtonLink>
      ) : null}
      <p className="text-caption text-text-muted">{g('showAtDoor')}</p>
    </div>
  );
}

/**
 * A guest booking in the shape the print sheet takes.
 *
 * The box office and the account wallet print through `PrintableTickets`, and so does a guest
 * now - one sheet, so the ticket a guest prints says exactly what the counter copy says. Only
 * CONFIRMED tickets with the fields that sheet reads; nothing is invented to fill a gap.
 */
export function guestTicketsForPrint(view: GuestBookingView): WalletTicket[] {
  return view.tickets.map((ticket) => ({
    id: ticket.id,
    serial: ticket.serial,
    status: 'VALID',
    holderName: view.buyer.name,
    ticketType: ticket.ticketTypeName ?? '',
    event: { title: view.event.title, slug: view.event.slug },
    startsAt: view.event.startsAt,
    qrDataUrl: ticket.qrDataUrl,
    bookingId: view.id,
    bookingRef: view.reference ?? undefined,
    seatLabel: ticket.seatLabel,
    venueName: view.event.venueName,
    cinemaName: view.event.cinemaName,
    screenName: view.event.screenName,
    timezone: view.event.timeZone,
  }));
}

/**
 * The guest's tickets on paper, or full size on a phone.
 *
 * Rendered on a route ending in `/print`, which the site chrome leaves without a header - the
 * print sheet is built for a bare page, because hiding a header at print time has already
 * silently dropped every ticket after the first. Not auto-printing: a guest opening this at the
 * door wants the QR on screen, not a print dialog in front of it.
 */
export function GuestPrintSheet({
  view,
  backHref,
  isLoading,
  isError,
}: {
  view: GuestBookingView | undefined;
  backHref: string;
  isLoading: boolean;
  isError: boolean;
}) {
  const g = useTranslations('storefront.guest');
  const tickets = view ? guestTicketsForPrint(view) : [];
  const ready = !isLoading && !isError && tickets.length > 0;

  return (
    <>
      <div className="no-print mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-3 p-6">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 rounded-md text-[0.9375rem] font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> {g('printBack')}
        </Link>
        {ready ? (
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 rounded-md bg-action-primary px-4 py-2 text-[0.9375rem] font-medium text-action-primary-foreground transition-colors hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            <Printer className="h-4 w-4" aria-hidden /> {g('printButton')}
          </button>
        ) : null}
      </div>
      {isLoading ? (
        <p className="mx-auto max-w-2xl px-6 text-sm">{g('printLoading')}</p>
      ) : !ready ? (
        <p className="mx-auto max-w-2xl px-6 text-sm">{g('printError')}</p>
      ) : (
        <PrintableTickets tickets={tickets} />
      )}
    </>
  );
}

/**
 * Signed out, and this browser is not holding the booking either.
 *
 * Reached by opening a booking link in a different browser, or after site data was cleared.
 * There is nothing to show and nothing to guess at, so the page says what to do instead: the
 * emailed link opens the booking, and "find my booking" sends that link again. It is shown by
 * both the payment and the confirmation screens, which fail this way for the same reason.
 */
export function GuestBookingNotHere() {
  const g = useTranslations('storefront.guest');

  return (
    <Card className="mx-auto max-w-md space-y-3 text-center">
      <h1 className="text-title font-semibold text-text-primary">{g('noAccessTitle')}</h1>
      <p className="text-[0.9375rem] text-text-secondary">{g('noAccessBody')}</p>
      <div className="flex flex-col gap-3 pt-1 sm:flex-row">
        <ButtonLink href="/booking/find" className="w-full sm:flex-1">
          {g('findTitle')}
        </ButtonLink>
        <ButtonLink href="/login" variant="outline" className="w-full sm:flex-1">
          {g('signIn')}
        </ButtonLink>
      </div>
    </Card>
  );
}
