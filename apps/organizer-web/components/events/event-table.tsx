'use client';

import { useRouter } from 'next/navigation';
import { DataTable, ImageFrame, type Column, type SellingState } from '@eticketsgo/web-kit';
import { EventStateBadges } from './event-state-badges';
import { EventActions } from './event-actions';
import { SaleStatePill, SalesLines, SoldMeter, cardImage } from './event-card';
import {
  imageCategoryOf,
  scheduleSummary,
  soldOfCapacity,
  type EventListRow,
} from './event-list-model';

/**
 * The same events as rows, for scanning many at once.
 *
 * ── WHY COLUMNS LEAVE RATHER THAN THE TABLE SCROLLING ──────────────────────────────
 * A table that scrolls sideways hides its right-hand columns - the actions - from anybody who
 * does not know to drag it. So the venue lives under the title at every width (a separate venue
 * column pushed the "..." menu out of view even at 1440), and the next session and gross sales
 * step out below `xl`, where the schedule moves under the title too. What always remains is the
 * event, its state and its actions. Below `sm` the page shows cards instead.
 *
 * Ordering is the page's (one sort control for both views), so no column sorts itself.
 */
export function EventTable({
  rows,
  showSales,
  saleOf,
  duplicatingId,
  onDuplicate,
  onDelete,
}: {
  rows: EventListRow[];
  /** False for a member who may not see money: the column is left out, not shown empty. */
  showSales: boolean;
  /** The server's unified sale state per event, said under its stage. */
  saleOf: (eventId: string) => { selling: SellingState | null; unavailable: boolean };
  duplicatingId: string | null;
  onDuplicate: (e: EventListRow) => void;
  onDelete: (e: EventListRow) => void;
}) {
  const router = useRouter();
  const columns: Column<EventListRow>[] = [
    {
      key: 'event',
      header: 'Event',
      render: (e) => {
        const schedule = scheduleSummary(e);
        return (
          <div className="flex min-w-0 items-start gap-3">
            <div className="w-16 shrink-0">
              <ImageFrame
                src={cardImage(e)?.src}
                alt=""
                ratio="16:9"
                category={imageCategoryOf(e.category)}
                rounded="md"
              />
            </div>
            <div className="min-w-0 max-w-[16rem]">
              <p className="line-clamp-2 break-words font-semibold text-text-primary [overflow-wrap:anywhere]">
                {e.title}
              </p>
              <p
                className="truncate text-caption text-text-muted"
                title={`${e.venue.name}, ${e.venue.city}`}
              >
                {e.category} - {e.venue.name}, {e.venue.city}
              </p>
              {/* Said here only where their own columns have stepped out. */}
              <p className="break-words text-caption tabular-nums text-text-muted xl:hidden">
                {schedule.lead ? `${schedule.lead}: ` : ''}
                {schedule.when}
              </p>
              <p className="text-caption tabular-nums text-text-muted xl:hidden">
                {soldOfCapacity(e.tickets).percent === null
                  ? soldOfCapacity(e.tickets).label
                  : `${soldOfCapacity(e.tickets).label} sold`}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      key: 'schedule',
      header: 'Next session',
      className: 'hidden xl:table-cell',
      render: (e) => {
        const s = scheduleSummary(e);
        return (
          <div className="w-40 text-ui tabular-nums">
            {s.lead ? <span className="text-text-muted">{s.lead}: </span> : null}
            {s.when}
            {s.more ? <p className="text-caption text-text-muted">{s.more}</p> : null}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (e) => {
        const sale = saleOf(e.id);
        return (
          <div className="flex min-w-0 max-w-[11rem] flex-col items-start gap-1.5">
            <EventStateBadges event={e} />
            <SaleStatePill selling={sale.selling} unavailable={sale.unavailable} />
          </div>
        );
      },
    },
    {
      key: 'tickets',
      header: showSales ? 'Sold / gross' : 'Sold / capacity',
      className: 'hidden xl:table-cell',
      render: (e) => (
        <div className="w-32 space-y-1">
          <SoldMeter event={e} />
          {showSales ? (
            <div className="text-caption">
              <SalesLines event={e} />
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'actions',
      // `relative` for the same reason as the approval badge: see EventStateBadges.
      header: (
        <span className="relative">
          <span className="sr-only">Actions</span>
        </span>
      ),
      render: (e) => (
        <EventActions
          inTable
          event={e}
          duplicating={duplicatingId === e.id}
          onDuplicate={() => onDuplicate(e)}
          onDelete={() => onDelete(e)}
        />
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(e) => e.id}
      onRowClick={(e) => router.push(`/organizer/events/${e.id}`)}
    />
  );
}
