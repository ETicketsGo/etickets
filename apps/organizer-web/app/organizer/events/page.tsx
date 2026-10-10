'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, LayoutGrid, List, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import {
  api,
  Button,
  Dialog,
  ButtonLink,
  EmptyState,
  ErrorState,
  Input,
  Select,
  SkeletonCard,
  Pagination,
  PageHeader,
  useToast,
  errorMessage,
} from '@eticketsgo/web-kit';
import type { EventSaleState } from '@eticketsgo/shared-types';
import { useOrg } from '@/components/org-context';
import { useWorkspace } from '@/components/workspace-chrome';
import { eventSaleStates } from '@/lib/sale-state';
import { EventCard } from '@/components/events/event-card';
import { EventTable } from '@/components/events/event-table';
import { EventCalendarView } from '@/components/events/event-calendar-view';
import {
  NO_FILTERS,
  SALE_FILTER_LABELS,
  SORT_LABELS,
  VIEW_STORAGE_KEY,
  filterBySale,
  filterEvents,
  filterOptions,
  parseView,
  sellingStateOf,
  sortEvents,
  type EventFilters,
  type EventListRow,
  type EventListView,
  type EventSort,
  type SaleFilter,
} from '@/components/events/event-list-model';

const STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'PUBLISHED',
  'PAUSED',
  'SOLD_OUT',
  'COMPLETED',
  'CANCELLED',
];

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  UNDER_REVIEW: 'In review',
  PUBLISHED: 'Published',
  PAUSED: 'Paused',
  SOLD_OUT: 'Sold out',
  COMPLETED: 'Ended',
  CANCELLED: 'Cancelled',
};

/** Divisible by 2, 3 and 4, so every grid width ends on a full row. */
const PAGE_SIZE = 12;

/*
  Whether the screen is wide enough for the table (Tailwind's `sm`, 640px).

  Below it the table is two columns - the event and its actions - with everything else either
  folded into the first cell or gone, which is a worse card. So a phone shows cards whichever
  view is chosen, and says so; the choice is kept for the next wide screen. Asked of the
  browser rather than hidden with CSS, because two copies of every title in the page (one
  hidden) makes "find this event" find two.
*/
const WIDE_QUERY = '(min-width: 640px)';
function subscribeWide(onChange: () => void) {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

const VIEWS: { value: EventListView; label: string; icon: typeof LayoutGrid }[] = [
  { value: 'cards', label: 'Cards', icon: LayoutGrid },
  { value: 'table', label: 'Table', icon: List },
  { value: 'calendar', label: 'Calendar', icon: CalendarDays },
];

const toggleButton = (active: boolean) =>
  `inline-flex h-8 items-center gap-1.5 rounded-sm px-2.5 text-caption font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 sm:px-3 ${
    active
      ? 'bg-background-surface text-text-primary shadow-xs'
      : 'text-text-secondary hover:text-text-primary'
  }`;

/** The filter fields' size: a toolbar, not a form - 40px high, the UI type size. */
const compact = '!py-2 !text-ui';

/*
  ── WHERE THE SEARCHING HAPPENS ──────────────────────────────────────────────────
  In the browser. `GET /events?organizationId=` returns the organization's whole list in one
  response - it takes no search, filter, sort or page parameters - so filtering, ordering and
  paging run over that list here. An organization's own events are a bounded set (the busiest
  local org has 180+, which this handles); if one ever grows past that, these move to the
  server together.

  The one exception is the SALE STATE, which is not on the row: it is the server's unified
  answer, asked for the page's twelve events - or, once somebody filters by it, for every event
  the other filters kept, in batches of 50.
*/
export default function OrganizerEvents() {
  const { activeOrg } = useOrg();
  const { can } = useWorkspace();
  const mayCreate = can.financials || can.ownerActions;
  const router = useRouter();
  const [filters, setFilters] = useState<EventFilters>(NO_FILTERS);
  const [sort, setSort] = useState<EventSort>('newest');
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [deleting, setDeleting] = useState<EventListRow | null>(null);
  const [view, setViewState] = useState<EventListView>('cards');
  const wide = useWide();

  /*
    Remembered per device: an organizer who works in the table should not have to choose it on
    every visit. Read after mount, because the server render cannot see storage - reading it
    during render would draw cards on the server and a table in the browser. Storage can be
    refused (a private window, blocked site data), so every touch of it is allowed to fail.
  */
  useEffect(() => {
    try {
      setViewState(parseView(window.localStorage.getItem(VIEW_STORAGE_KEY)));
    } catch {
      /* cards, the default */
    }
  }, []);
  const setView = (next: EventListView) => {
    setViewState(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      /* remembered for this visit only */
    }
  };

  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['events', activeOrg.id],
    // The API's row carries more than web-kit's type says yet; see EventListRow.
    queryFn: async () => (await api.events.list(activeOrg.id)) as EventListRow[],
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.events.duplicate(id),
    onSuccess: (created) => {
      toast.push('Event duplicated as a new draft.', 'success');
      qc.invalidateQueries({ queryKey: ['events', activeOrg.id] });
      router.push(`/organizer/events/${created.id}`);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.events.remove(id),
    onSuccess: () => {
      toast.push('Event deleted.', 'success');
      qc.invalidateQueries({ queryKey: ['events', activeOrg.id] });
      setDeleting(null);
    },
    onError: (e) => {
      toast.push(errorMessage(e), 'error');
      setDeleting(null);
    },
  });

  const all = useMemo(() => data ?? [], [data]);
  const options = useMemo(() => filterOptions(all), [all]);
  // Every filter but the sale state, which needs the server's answers first.
  const narrowed = useMemo(
    () => sortEvents(filterEvents(all, filters), sort),
    [all, filters, sort],
  );
  // Null sales on every row means this member may not see money: the column and the sort go.
  const showSales = all.some((e) => Array.isArray(e.sales));

  /*
    The sale states for every event the other filters kept - asked only while somebody filters
    by sale state, because it is one server check per event.
  */
  const narrowedIds = useMemo(
    () => (filters.sale ? narrowed.map((e) => e.id).sort() : []),
    [filters.sale, narrowed],
  );
  const allSalesQ = useQuery({
    queryKey: ['organizer-event-sale-states', activeOrg.id, 'list', narrowedIds.join(',')],
    queryFn: () => eventSaleStates(activeOrg.id, narrowedIds),
    enabled: narrowedIds.length > 0,
    staleTime: 60_000,
    retry: 1,
  });

  const [answers, setAnswers] = useState<Map<string, EventSaleState>>(new Map());
  const remember = (list: EventSaleState[] | undefined) => {
    if (!list?.length) return;
    setAnswers((prev) => {
      const next = new Map(prev);
      for (const a of list) next.set(a.eventId, a);
      return next;
    });
  };
  useEffect(() => remember(allSalesQ.data), [allSalesQ.data]);

  const { rows, pending } = useMemo(
    () => filterBySale(narrowed, filters.sale, (id) => answers.get(id)?.state),
    [narrowed, filters.sale, answers],
  );

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  /*
    Whether each event on this page is selling: the server's unified answer over its upcoming
    shows, the same one the Overview and the event page show. Asked for the page's events only
    (12, under the server's cap of 50), in one request. Owners and managers may ask; anybody
    else sees "Sale status unavailable" on each card, never a guess.

    Its own key segment ('list'): the event page caches the same endpoint's raw `{ events }`
    response under ['organizer-event-sale-states', org, id], and a one-event page here must not
    read that shape as its list - or write its list where the event page reads.
  */
  const pageIds = useMemo(() => pageRows.map((e) => e.id).sort(), [pageRows]);
  const salesQ = useQuery({
    queryKey: ['organizer-event-sale-states', activeOrg.id, 'list', pageIds.join(',')],
    queryFn: () => eventSaleStates(activeOrg.id, pageIds),
    enabled: pageIds.length > 0 && view !== 'calendar',
    staleTime: 60_000,
    retry: 1,
  });
  useEffect(() => remember(salesQ.data), [salesQ.data]);
  const saleOf = (eventId: string) => ({
    selling: sellingStateOf(answers.get(eventId)),
    unavailable: !answers.has(eventId) && (salesQ.isError || allSalesQ.isError),
  });

  const set = (patch: Partial<EventFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const activeFilters = [
    filters.status,
    filters.sale,
    filters.venue,
    filters.category,
    filters.from,
    filters.to,
  ].filter(Boolean).length;

  const duplicatingId = duplicate.isPending ? (duplicate.variables ?? null) : null;
  const shown = view === 'table' && !wide ? 'cards' : view;
  const keep = useMemo(() => new Set(rows.map((e) => e.id)), [rows]);
  const first = rows.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const last = Math.min(currentPage * PAGE_SIZE, rows.length);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Events"
        description={
          isLoading
            ? undefined
            : `${all.length} event${all.length === 1 ? '' : 's'} in ${activeOrg.name}`
        }
        /*
          The top bar carries "Create event" from `sm` up. Below that it has no room, so the page
          offers it - once, never both on one screen.
        */
        action={
          mayCreate ? (
            <span className="sm:hidden">
              <ButtonLink href="/organizer/events/new" icon={Plus} size="sm">
                Create event
              </ButtonLink>
            </span>
          ) : undefined
        }
      />

      <section
        aria-label="Find events"
        className="space-y-3 rounded-lg border border-border bg-background-surface p-3 shadow-xs sm:p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <form
            role="search"
            className="relative min-w-0 flex-1 basis-56"
            onSubmit={(e) => e.preventDefault()}
          >
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
              aria-hidden
            />
            <input
              type="search"
              value={filters.q}
              onChange={(e) => set({ q: e.target.value })}
              placeholder="Search events…"
              aria-label="Search events by title, venue or city"
              className="h-10 w-full rounded-md border border-border-input bg-background-surface pl-9 pr-3 text-ui text-text-primary placeholder:text-text-muted focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/15"
            />
          </form>
          <Button
            variant="outline"
            size="sm"
            className="!h-10 md:hidden"
            aria-expanded={filtersOpen}
            aria-controls="event-filters"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            Filters{activeFilters ? ` (${activeFilters})` : ''}
          </Button>
          <div
            role="group"
            aria-label="Show events as"
            className="inline-flex rounded-md border border-border bg-background-subtle p-0.5"
          >
            {VIEWS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                className={toggleButton(view === value)}
                onClick={() => setView(value)}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/*
          Below `md` the filters fold behind one button: six stacked fields pushed the first
          event below the fold of a phone. From `md` up they are always shown, in one row from
          `xl`.
        */}
        <div
          id="event-filters"
          className={`${filtersOpen ? 'grid' : 'hidden'} grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:grid md:grid-cols-3 xl:grid-cols-6`}
        >
          <Select
            label="Status"
            value={filters.status}
            className={compact}
            onChange={(e) => set({ status: e.target.value })}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          <Select
            label="Sale state"
            value={filters.sale}
            className={compact}
            onChange={(e) => set({ sale: e.target.value as SaleFilter })}
          >
            <option value="">Any sale state</option>
            {(Object.keys(SALE_FILTER_LABELS) as (keyof typeof SALE_FILTER_LABELS)[]).map((s) => (
              <option key={s} value={s}>
                {SALE_FILTER_LABELS[s]}
              </option>
            ))}
          </Select>
          <Select
            label="Venue"
            value={filters.venue}
            className={compact}
            onChange={(e) => set({ venue: e.target.value })}
          >
            <option value="">All venues</option>
            {options.venues.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </Select>
          <Select
            label="Category"
            value={filters.category}
            className={compact}
            onChange={(e) => set({ category: e.target.value })}
          >
            <option value="">All categories</option>
            {options.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Input
            type="date"
            label="On or after"
            value={filters.from}
            className={compact}
            max={filters.to || undefined}
            onChange={(e) => set({ from: e.target.value })}
          />
          <Input
            type="date"
            label="On or before"
            value={filters.to}
            className={compact}
            min={filters.from || undefined}
            onChange={(e) => set({ to: e.target.value })}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border pt-3">
          <p className="text-ui text-text-secondary" aria-live="polite">
            {isLoading ? (
              'Loading events'
            ) : (
              <>
                {shown === 'calendar' ? (
                  `${rows.length} of ${all.length} events in the calendar`
                ) : (
                  <>
                    Showing{' '}
                    <span className="font-semibold tabular-nums text-text-primary">
                      {rows.length}
                    </span>{' '}
                    of <span className="tabular-nums">{all.length}</span> event
                    {all.length === 1 ? '' : 's'}
                  </>
                )}
                {pending > 0 ? ` (checking sale state for ${pending} more)` : ''}
              </>
            )}
            {activeFilters || filters.q ? (
              <>
                {' - '}
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 rounded-sm font-semibold text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => set(NO_FILTERS)}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                  Clear filters
                </button>
              </>
            ) : null}
          </p>
          {shown !== 'calendar' ? (
            <div className="flex items-center gap-2">
              <label htmlFor="event-sort" className="text-caption font-medium text-text-secondary">
                Sort by
              </label>
              <select
                id="event-sort"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as EventSort);
                  setPage(1);
                }}
                className="h-9 cursor-pointer rounded-md border border-border-input bg-background-surface px-2.5 text-ui text-text-primary focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/15"
              >
                {(Object.keys(SORT_LABELS) as EventSort[])
                  .filter((s) => s !== 'gross' || showSales)
                  .map((s) => (
                    <option key={s} value={s}>
                      {SORT_LABELS[s]}
                    </option>
                  ))}
              </select>
            </div>
          ) : null}
        </div>
        {view === 'table' && !wide ? (
          <p className="text-caption text-text-muted">
            The table needs a wider screen, so events show as cards here.
          </p>
        ) : null}
      </section>

      {isError ? (
        <ErrorState
          message="We couldn't load your events. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <div className={GRID} role="status" aria-label="Loading">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} variant="media" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <EmptyState
          title="No events yet"
          hint="Create your first event, add a session and tickets, then submit it for approval."
          action={
            mayCreate ? <ButtonLink href="/organizer/events/new">Create event</ButtonLink> : null
          }
        />
      ) : shown === 'calendar' ? (
        <EventCalendarView organizationId={activeOrg.id} keep={keep} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={pending > 0 ? 'Checking sale states' : 'No events match your filters'}
          hint={
            pending > 0
              ? 'Asking the server whether each event is selling. This takes a moment.'
              : undefined
          }
          action={
            <Button variant="outline" onClick={() => set(NO_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      ) : shown === 'cards' ? (
        <ul className={GRID} aria-label="Events">
          {pageRows.map((e, i) => {
            const sale = saleOf(e.id);
            return (
              <li key={e.id} className="flex min-w-0">
                <EventCard
                  event={e}
                  selling={sale.selling}
                  saleUnavailable={sale.unavailable}
                  priority={i < 4}
                  duplicating={duplicatingId === e.id}
                  onDuplicate={() => duplicate.mutate(e.id)}
                  onDelete={() => setDeleting(e)}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <EventTable
          rows={pageRows}
          showSales={showSales}
          saleOf={saleOf}
          duplicatingId={duplicatingId}
          onDuplicate={(e) => duplicate.mutate(e.id)}
          onDelete={(e) => setDeleting(e)}
        />
      )}
      {shown !== 'calendar' && rows.length > 0 ? (
        <div className="space-y-2">
          <p className="text-center text-caption tabular-nums text-text-muted sm:text-left">
            {first}-{last} of {rows.length}
          </p>
          <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />
        </div>
      ) : null}

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this event?"
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              Delete event
            </Button>
          </>
        }
      >
        <p>
          <span className="font-medium text-text-primary">{deleting?.title}</span> will be deleted,
          with its sessions, ticket types and images. This cannot be undone.
        </p>
      </Dialog>
    </div>
  );
}

/*
  Cards at least 13.5rem wide, as many as fit: four at 1440, three beside the sidebar at 1024
  and at 768, one on a phone. With the 16:9 frame that keeps the artwork near the reference's
  120-150px rather than a 200px band per card.
*/
const GRID = 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,13.5rem),1fr))]';
