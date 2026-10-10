'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CalendarDays, LayoutGrid, List, SlidersHorizontal } from 'lucide-react';
import {
  api,
  Button,
  Dialog,
  ButtonLink,
  EmptyState,
  ErrorState,
  Input,
  Select,
  SearchInput,
  Skeleton,
  Pagination,
  PageHeader,
  useToast,
  errorMessage,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { EventCard } from '@/components/events/event-card';
import { EventTable } from '@/components/events/event-table';
import {
  NO_FILTERS,
  SORT_LABELS,
  VIEW_STORAGE_KEY,
  filterEvents,
  filterOptions,
  parseView,
  sortEvents,
  type EventFilters,
  type EventListRow,
  type EventListView,
  type EventSort,
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

const toggleButton = (active: boolean) =>
  `inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[0.875rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
    active
      ? 'bg-background-surface text-text-primary shadow-sm'
      : 'text-text-secondary hover:text-text-primary'
  }`;

/*
  ── WHERE THE SEARCHING HAPPENS ──────────────────────────────────────────────────
  In the browser. `GET /events?organizationId=` returns the organization's whole list in one
  response - it takes no search, filter, sort or page parameters - so filtering, ordering and
  paging run over that list here. An organization's own events are a bounded set (tens, not
  the storefront's thousands); if one ever grows past that, these move to the server together.
*/
export default function OrganizerEvents() {
  const { activeOrg } = useOrg();
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
  const rows = useMemo(() => sortEvents(filterEvents(all, filters), sort), [all, filters, sort]);
  // Null sales on every row means this member may not see money: the column and the sort go.
  const showSales = all.some((e) => Array.isArray(e.sales));

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const set = (patch: Partial<EventFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const activeFilters = [
    filters.status,
    filters.venue,
    filters.category,
    filters.from,
    filters.to,
  ].filter(Boolean).length;

  const duplicatingId = duplicate.isPending ? (duplicate.variables ?? null) : null;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Events"
        action={<ButtonLink href="/organizer/events/new">Create event</ButtonLink>}
      />

      <section aria-label="Find events" className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-60">
            <SearchInput
              value={filters.q}
              onChange={(v) => set({ q: v })}
              placeholder="Search events…"
            />
          </div>
          <Button
            variant="outline"
            className="md:hidden"
            aria-expanded={filtersOpen}
            aria-controls="event-filters"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            Filters{activeFilters ? ` (${activeFilters})` : ''}
          </Button>
        </div>

        {/*
          Below `md` the filters fold behind one button: six stacked fields pushed the first
          event below the fold of a phone. From `md` up they are always shown.
        */}
        <div
          id="event-filters"
          className={`${filtersOpen ? 'grid' : 'hidden'} grid-cols-1 gap-3 sm:grid-cols-2 md:grid md:grid-cols-3 xl:grid-cols-6`}
        >
          <div className="min-w-0">
            <Select
              label="Status"
              value={filters.status}
              onChange={(e) => set({ status: e.target.value })}
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s
                    .replaceAll('_', ' ')
                    .toLowerCase()
                    .replace(/^\w/, (c) => c.toUpperCase())}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0">
            <Select
              label="Venue"
              value={filters.venue}
              onChange={(e) => set({ venue: e.target.value })}
            >
              <option value="">All venues</option>
              {options.venues.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0">
            <Select
              label="Category"
              value={filters.category}
              onChange={(e) => set({ category: e.target.value })}
            >
              <option value="">All categories</option>
              {options.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0">
            <Input
              type="date"
              label="On or after"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(e) => set({ from: e.target.value })}
            />
          </div>
          <div className="min-w-0">
            <Input
              type="date"
              label="On or before"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(e) => set({ to: e.target.value })}
            />
          </div>
          <div className="min-w-0">
            <Select
              label="Sort by"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as EventSort);
                setPage(1);
              }}
            >
              {(Object.keys(SORT_LABELS) as EventSort[])
                .filter((s) => s !== 'gross' || showSales)
                .map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABELS[s]}
                  </option>
                ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[0.875rem] text-text-muted" aria-live="polite">
            {isLoading
              ? 'Loading events'
              : `Showing ${rows.length} of ${all.length} event${all.length === 1 ? '' : 's'}`}
            {activeFilters || filters.q ? (
              <>
                {' - '}
                <button
                  type="button"
                  className="font-medium text-action-primary underline-offset-2 hover:underline"
                  onClick={() => set(NO_FILTERS)}
                >
                  Clear filters
                </button>
              </>
            ) : null}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/*
            The same events by date. The list answers "how is each event doing"; the calendar
            answers "what is on when", and an organizer switches between the two questions.
          */}
            <Link
              href="/organizer/calendar"
              className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[0.875rem] font-medium text-action-primary hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <CalendarDays className="h-4 w-4" aria-hidden />
              Calendar
            </Link>
            <div
              role="group"
              aria-label="Show events as"
              className="inline-flex rounded-lg border border-border bg-background-subtle p-0.5"
            >
              <button
                type="button"
                aria-pressed={view === 'cards'}
                className={toggleButton(view === 'cards')}
                onClick={() => setView('cards')}
              >
                <LayoutGrid className="h-4 w-4" aria-hidden />
                Cards
              </button>
              <button
                type="button"
                aria-pressed={view === 'table'}
                className={toggleButton(view === 'table')}
                onClick={() => setView('table')}
              >
                <List className="h-4 w-4" aria-hidden />
                Table
              </button>
            </div>
          </div>
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
        <div
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          role="status"
          aria-label="Loading"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-72 w-full" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <EmptyState
          title="No events yet"
          hint="Create your first event, add a session and tickets, then submit it for approval."
          action={<ButtonLink href="/organizer/events/new">Create event</ButtonLink>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No events match your filters"
          action={
            <Button variant="outline" onClick={() => set(NO_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      ) : view === 'cards' || !wide ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Events">
          {pageRows.map((e) => (
            <li key={e.id} className="flex min-w-0">
              <EventCard
                event={e}
                duplicating={duplicatingId === e.id}
                onDuplicate={() => duplicate.mutate(e.id)}
                onDelete={() => setDeleting(e)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <EventTable
          rows={pageRows}
          showSales={showSales}
          duplicatingId={duplicatingId}
          onDuplicate={(e) => duplicate.mutate(e.id)}
          onDelete={(e) => setDeleting(e)}
        />
      )}
      <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />

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
