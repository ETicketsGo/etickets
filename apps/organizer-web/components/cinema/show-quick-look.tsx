'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Eye, LayoutGrid, Radio } from 'lucide-react';
import { api, Button, Drawer, Meter, Skeleton, money, type ShowRow } from '@eticketsgo/web-kit';
import {
  formatClock,
  formatShowTime,
  percentSold,
  zoneShort,
  type SaleVerdict,
} from './cinema-model';
import { SaleChip } from './sale-chip';

const LINK =
  'inline-flex items-center gap-1.5 rounded text-[0.875rem] font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * One show at a glance, without leaving the film: when and where, the layout it is seated
 * from, what it charges, how full it is, and whether it can be bought.
 *
 * Every figure is read from the API for THIS show: prices from the show pricing endpoint,
 * the layout from the version the show is pinned to (`seatMapId` on the live seat map), not
 * the screen's current one - a show sold from last month's layout is still seated from it.
 *
 * Changing the show goes through the existing edit dialog, which owns the move, reprice,
 * pause and cancel endpoints and their confirmations. Nothing here writes.
 */
export function ShowQuickLook({
  show,
  timeZone,
  verdict,
  onClose,
  onEdit,
}: {
  show: ShowRow | null;
  timeZone: string | undefined;
  verdict: SaleVerdict | null;
  onClose: () => void;
  onEdit: (show: ShowRow) => void;
}) {
  const open = show !== null;
  const sessionId = show?.sessionId ?? '';
  const pricingQ = useQuery({
    queryKey: ['show-pricing', sessionId],
    queryFn: () => api.shows.pricing(sessionId),
    enabled: open,
  });
  // The layout version the show is pinned to.
  const liveQ = useQuery({
    queryKey: ['live-seat-map', sessionId],
    queryFn: () => api.theaterOps.liveSeatMap(sessionId),
    enabled: open,
    retry: false,
  });
  const layoutsQ = useQuery({
    queryKey: ['screen', show?.screenId, 'layouts'],
    queryFn: () => api.theaterOps.layouts(show!.screenId!),
    enabled: open && Boolean(show?.screenId),
    retry: false,
  });
  const layout = layoutsQ.data?.find((l) => l.id === liveQ.data?.seatMapId) ?? null;

  /*
    Focus goes into the drawer when it opens and back to whatever opened it when it closes,
    so a keyboard user is never dropped at the top of the page.
  */
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement as HTMLElement | null;
      const t = window.setTimeout(() => {
        document
          .querySelector<HTMLElement>(
            '[role="dialog"][aria-label^="Show at"] button, [role="dialog"][aria-label^="Show at"] a',
          )
          ?.focus();
      }, 50);
      return () => window.clearTimeout(t);
    }
    opener.current?.focus();
    return undefined;
  }, [open]);

  if (!show)
    return (
      <Drawer open={false} onClose={onClose} title="Show">
        {null}
      </Drawer>
    );

  const zone = timeZone;
  const pct = percentSold(show.seatsSold, show.seatsTotal);
  const cinemaPath = show.cinemaId ? `/organizer/cinemas/${show.cinemaId}` : null;
  const editable =
    (show.status === 'SCHEDULED' || show.status === 'PAUSED') &&
    new Date(show.startsAt) > new Date();

  return (
    <Drawer open={open} onClose={onClose} title={`Show at ${formatShowTime(show.startsAt, zone)}`}>
      <div className="space-y-6 text-[0.875rem]">
        <section className="space-y-1">
          <p className="text-caption text-text-muted">
            {show.cinemaName ?? 'Unknown cinema'} - {show.screenName ?? 'No screen'}
          </p>
          <p className="text-h3 font-semibold tabular-nums text-text-primary">
            {formatClock(show.startsAt, zone)} to {formatClock(show.endsAt, zone)}{' '}
            <span className="text-caption font-normal text-text-muted">
              {zone ? `${zoneShort(show.startsAt, zone)}, cinema time` : 'your time'}
            </span>
          </p>
        </section>

        <section aria-labelledby="ql-sale" className="space-y-2">
          <h3
            id="ql-sale"
            className="text-caption font-semibold uppercase tracking-wide text-text-muted"
          >
            Online sales
          </h3>
          {verdict ? <SaleChip verdict={verdict} /> : null}
          {verdict?.detail ? <p className="text-text-secondary">{verdict.detail}</p> : null}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {verdict?.fixPath ? (
              <Link href={verdict.fixPath} className={LINK}>
                Fix this <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            ) : null}
            {cinemaPath && !verdict?.selling ? (
              <Link href={`${cinemaPath}/readiness`} className={LINK}>
                Cinema readiness <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="ql-seats" className="space-y-2">
          <h3
            id="ql-seats"
            className="text-caption font-semibold uppercase tracking-wide text-text-muted"
          >
            Seats
          </h3>
          <p className="tabular-nums text-text-primary">
            <span className="font-semibold">{show.seatsSold}</span> of {show.seatsTotal} sold
            {pct !== null ? ` (${pct}%)` : ''}
          </p>
          {show.seatsTotal > 0 ? (
            <Meter value={show.seatsSold} max={show.seatsTotal} label="Seats sold for this show" />
          ) : null}
        </section>

        <section aria-labelledby="ql-layout" className="space-y-2">
          <h3
            id="ql-layout"
            className="text-caption font-semibold uppercase tracking-wide text-text-muted"
          >
            Screen and seating
          </h3>
          {liveQ.isLoading || layoutsQ.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <p className="text-text-primary">
              {show.screenName ?? 'No screen'}
              {layout ? (
                <>
                  {' '}
                  - layout version {layout.version}
                  {layout.name ? ` (${layout.name})` : ''}, {layout.capacity} seats
                </>
              ) : (
                <span className="text-text-muted"> - layout version not available</span>
              )}
            </p>
          )}
          {cinemaPath && show.screenId ? (
            <div className="flex flex-col gap-1.5">
              {layout ? (
                <Link
                  href={`${cinemaPath}/screens/${show.screenId}/layouts/${layout.id}/preview`}
                  className={LINK}
                >
                  <Eye className="h-4 w-4" aria-hidden /> Preview this layout
                </Link>
              ) : null}
              <Link href={`${cinemaPath}/screens/${show.screenId}/seatmap`} className={LINK}>
                <LayoutGrid className="h-4 w-4" aria-hidden /> Seat map for{' '}
                {show.screenName ?? 'this screen'}
              </Link>
              <Link href={`${cinemaPath}/live`} className={LINK}>
                <Radio className="h-4 w-4" aria-hidden /> Live seat view
              </Link>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="ql-prices" className="space-y-2">
          <h3
            id="ql-prices"
            className="text-caption font-semibold uppercase tracking-wide text-text-muted"
          >
            Prices for this show
          </h3>
          {pricingQ.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : pricingQ.isError ? (
            <p className="text-text-muted">Prices could not be loaded.</p>
          ) : (pricingQ.data?.categories.length ?? 0) === 0 ? (
            <p className="text-text-muted">This show has no seat categories.</p>
          ) : (
            <table className="w-full text-left">
              <caption className="sr-only">Price per seat category</caption>
              <thead>
                <tr className="text-caption text-text-muted">
                  <th scope="col" className="pb-1 font-medium">
                    Category
                  </th>
                  <th scope="col" className="pb-1 text-right font-medium">
                    Price
                  </th>
                  <th scope="col" className="pb-1 text-right font-medium">
                    Sold
                  </th>
                </tr>
              </thead>
              <tbody>
                {pricingQ.data!.categories.map((c) => (
                  <tr key={c.ticketTypeId} className="border-t border-border">
                    <td className="py-1.5 text-text-primary">
                      <span className="flex items-center gap-2">
                        {c.colorHex ? (
                          <span
                            aria-hidden
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: c.colorHex }}
                          />
                        ) : null}
                        {c.name}
                      </span>
                    </td>
                    <td className="py-1.5 text-right font-medium tabular-nums text-text-primary">
                      {money(c.priceMinor, c.currency)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-text-secondary">
                      {c.soldCount} / {c.seatCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="space-y-2 border-t border-border pt-4">
          {editable ? (
            <>
              <Button onClick={() => onEdit(show)} className="w-full">
                Edit, pause or cancel this show
              </Button>
              <p className="text-caption text-text-muted">
                Move it, change its prices, stop selling for a while, or cancel it. Each change asks
                before it is made.
              </p>
            </>
          ) : (
            <p className="text-caption text-text-muted">
              This show has {show.status === 'CANCELLED' ? 'been cancelled' : 'started'}, so it can
              no longer be changed here.
            </p>
          )}
        </section>
      </div>
    </Drawer>
  );
}
