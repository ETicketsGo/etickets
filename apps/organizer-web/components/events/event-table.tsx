'use client';

import { useRouter } from 'next/navigation';
import { DataTable, type Column } from '@eticketsgo/web-kit';
import { EventArtwork } from './event-artwork';
import { EventStateBadges } from './event-state-badges';
import { EventActions } from './event-actions';
import { SalesLines, SoldMeter } from './event-card';
import { scheduleSummary, type EventListRow } from './event-list-model';

/**
 * The same events as rows, for scanning many at once.
 *
 * ── WHY COLUMNS LEAVE RATHER THAN THE TABLE SCROLLING ──────────────────────────────
 * Seven columns do not fit a phone, and a table that scrolls sideways hides its right-hand
 * columns from anybody who does not know to drag it. So the columns that are also said in
 * the first cell step out as the screen narrows. The console's sidebar takes a fixed share, so at
 * 1024 the table has about 750px: the venue and schedule then live under the title, and gross
 * sales (also on each card) appear from `xl`. What always remains is the event, its state and
 * its actions. Below `sm` the page shows cards instead: two columns are a worse card.
 *
 * Ordering is the page's (one sort control for both views), so no column sorts itself.
 */
export function EventTable({
  rows,
  showSales,
  duplicatingId,
  onDuplicate,
  onDelete,
}: {
  rows: EventListRow[];
  /** False for a member who may not see money: the column is left out, not shown empty. */
  showSales: boolean;
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
            <EventArtwork
              id={e.id}
              title={e.title}
              imagePath={e.imagePath}
              imageVariants={e.imageVariants}
              use="thumb"
              className="h-12 w-12 rounded-md text-xl"
            />
            <div className="min-w-0">
              <p className="line-clamp-2 break-words font-medium text-text-primary">{e.title}</p>
              <p className="truncate text-caption text-text-muted">{e.category}</p>
              {/* Said here only where their own columns have stepped out. */}
              <p className="line-clamp-2 break-words text-caption text-text-muted xl:hidden">
                {e.venue.name}, {e.venue.city}
              </p>
              <p className="break-words text-caption text-text-muted xl:hidden">
                {schedule.lead ? `${schedule.lead}: ` : ''}
                {schedule.when}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      key: 'venue',
      header: 'Venue',
      className: 'hidden xl:table-cell',
      render: (e) => (
        <div className="max-w-[14rem]">
          <p className="line-clamp-2 break-words">{e.venue.name}</p>
          <p className="text-caption text-text-muted">{e.venue.city}</p>
        </div>
      ),
    },
    {
      key: 'schedule',
      header: 'Schedule',
      className: 'hidden xl:table-cell',
      render: (e) => {
        const s = scheduleSummary(e);
        return (
          <div className="max-w-[13rem] text-[0.875rem]">
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
      render: (e) => <EventStateBadges event={e} />,
    },
    {
      key: 'tickets',
      header: 'Sold / capacity',
      className: 'hidden md:table-cell',
      render: (e) => <SoldMeter event={e} compact />,
    },
    ...(showSales
      ? [
          {
            key: 'gross',
            header: 'Gross sales',
            className: 'hidden xl:table-cell',
            render: (e: EventListRow) => <SalesLines event={e} />,
          },
        ]
      : []),
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
