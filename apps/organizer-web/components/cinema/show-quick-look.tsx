'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Eye, LayoutGrid, Radio, Scale } from 'lucide-react';
import {
  api,
  Button,
  Drawer,
  IconTile,
  ProgressMeter,
  Skeleton,
  StatusPill,
  money,
  type ShowRow,
} from '@eticketsgo/web-kit';
import { formatClock, formatShowTime, zoneShort, type SaleVerdict } from './cinema-model';
import { SalePill } from './sale-pill';
import { SeatPreview } from './seat-preview';

const LINK =
  'inline-flex items-center gap-1.5 rounded-sm text-ui font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2.5">
      <h3 id={id} className="text-micro font-semibold uppercase tracking-[0.08em] text-text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * One show at a glance, without leaving the film: when and where, whether it can be bought,
 * how full it is, what each category charges, the price rules that apply at its cinema, and
 * the layout it is seated from.
 *
 * Every figure is read from the API for THIS show: prices from the show pricing endpoint, the
 * layout from the version the show is pinned to (the live seat map), not the screen's current
 * one - a show sold from last month's layout is still seated from it. The price rules are the
 * cinema's compliance view, shown read-only: what the server enforces at booking and publish
 * time, explained here, decided there.
 *
 * Changing the show goes through the existing edit dialog, which owns the move, reprice,
 * pause and cancel endpoints and their confirmations. Nothing here writes. Focus goes back to
 * the button that opened the drawer when it closes - the Drawer does that itself.
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
  // The layout version the show is pinned to, and its seats for the preview.
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
  const complianceQ = useQuery({
    queryKey: ['cinema-pricing-compliance', show?.cinemaId],
    queryFn: () => api.cinemas.pricingCompliance(show!.cinemaId!),
    enabled: open && Boolean(show?.cinemaId),
    retry: false,
    staleTime: 60_000,
  });
  const layout = layoutsQ.data?.find((l) => l.id === liveQ.data?.seatMapId) ?? null;

  if (!show)
    return (
      <Drawer open={false} onClose={onClose} title="Show">
        {null}
      </Drawer>
    );

  const zone = timeZone;
  const cinemaPath = show.cinemaId ? `/organizer/cinemas/${show.cinemaId}` : null;
  const editable =
    (show.status === 'SCHEDULED' || show.status === 'PAUSED') &&
    new Date(show.startsAt) > new Date();
  const rules = complianceQ.data;
  // Shown only where a rule applies. NOT_REGULATED is ordinary platform pricing - no panel.
  const regulated = rules && rules.status !== 'NOT_REGULATED';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`Show at ${formatShowTime(show.startsAt, zone)}`}
      footer={
        editable ? (
          <div className="w-full space-y-2">
            <Button onClick={() => onEdit(show)} className="w-full">
              Edit, pause or cancel this show
            </Button>
            <p className="text-caption text-text-muted">
              Move it, change its prices, stop selling for a while, or cancel it. Each change asks
              before it is made.
            </p>
          </div>
        ) : (
          <p className="text-caption text-text-muted">
            This show has {show.status === 'CANCELLED' ? 'been cancelled' : 'started'}, so it can no
            longer be changed here.
          </p>
        )
      }
    >
      <div className="space-y-6 text-ui">
        <section className="rounded-lg border border-border bg-background-subtle/60 p-4">
          <p className="text-caption text-text-secondary">
            {show.cinemaName ?? 'Unknown cinema'} - {show.screenName ?? 'No screen'}
          </p>
          <p className="mt-1 font-display text-[1.375rem] font-bold leading-tight tabular-nums text-text-primary">
            {formatClock(show.startsAt, zone)} to {formatClock(show.endsAt, zone)}
          </p>
          <p className="text-caption text-text-muted">
            {zone ? `${zoneShort(show.startsAt, zone)}, cinema time` : 'your time'}
          </p>
          <div className="mt-3">
            <ProgressMeter
              value={show.seatsSold}
              max={show.seatsTotal}
              label="Seats sold for this show"
            />
          </div>
        </section>

        <Section id="ql-sale" title="Online sales">
          {verdict ? <SalePill verdict={verdict} /> : null}
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
        </Section>

        <Section id="ql-prices" title="Ticket categories">
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
                  <th scope="col" className="pb-1.5 font-medium">
                    Category
                  </th>
                  <th scope="col" className="pb-1.5 text-right font-medium">
                    Price
                  </th>
                  <th scope="col" className="pb-1.5 text-right font-medium">
                    Sold
                  </th>
                </tr>
              </thead>
              <tbody>
                {pricingQ.data!.categories.map((c) => (
                  <tr key={c.ticketTypeId} className="border-t border-border">
                    <td className="py-2 text-text-primary">
                      <span className="flex flex-wrap items-center gap-2">
                        <span
                          aria-hidden
                          className="h-2.5 w-2.5 shrink-0 rounded-full bg-text-muted"
                          style={c.colorHex ? { backgroundColor: c.colorHex } : undefined}
                        />
                        <span className="min-w-0 break-words">{c.name}</span>
                        {c.locked ? (
                          <StatusPill tone="neutral" size="sm" dot={false}>
                            Price fixed
                          </StatusPill>
                        ) : null}
                      </span>
                    </td>
                    <td className="py-2 text-right font-semibold tabular-nums text-text-primary">
                      {money(c.priceMinor, c.currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-text-secondary">
                      {c.soldCount} / {c.seatCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        {regulated ? (
          <Section id="ql-rules" title="Price rules at this cinema">
            <div className="flex gap-3 rounded-lg border border-border p-3">
              <IconTile icon={Scale} tone={rules.blocksPublishing ? 'rose' : 'amber'} size="sm" />
              <div className="min-w-0 space-y-1">
                <p className="text-text-primary">{rules.summary}</p>
                <dl className="space-y-0.5 text-caption text-text-secondary">
                  {rules.maxTicketPriceMinor != null ? (
                    <div className="flex flex-wrap gap-x-1">
                      <dt>Maximum ticket price:</dt>
                      <dd className="font-semibold tabular-nums text-text-primary">
                        {money(rules.maxTicketPriceMinor, 'INR')}
                      </dd>
                    </div>
                  ) : null}
                  {rules.regulatoryReference ? (
                    <div className="flex flex-wrap gap-x-1">
                      <dt>Order:</dt>
                      <dd className="break-words">{rules.regulatoryReference}</dd>
                    </div>
                  ) : null}
                </dl>
                <p className="text-micro text-text-muted">
                  Read only. Checkout and publishing apply these rules themselves.
                </p>
              </div>
            </div>
          </Section>
        ) : null}

        <Section id="ql-layout" title="Screen and seating">
          {liveQ.isLoading || layoutsQ.isLoading ? (
            <Skeleton className="h-28 w-full" />
          ) : (
            <>
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
              {liveQ.data ? <SeatPreview map={liveQ.data} /> : null}
            </>
          )}
          {cinemaPath && show.screenId ? (
            <div className="flex flex-col gap-2 pt-1">
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
        </Section>
      </div>
    </Drawer>
  );
}
