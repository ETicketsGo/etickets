'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Badge,
  Card,
  DataTable,
  StatusBadge,
  Select,
  SearchInput,
  Pagination,
  PageHeader,
  GroupedSummary,
  type GroupSelection,
  EmptyState,
  dateOnly,
  type Column,
  type AdminEventRow,
} from '@eticketsgo/web-kit';
import { CountryFilter, CountryLabel, useCountryParam } from '../../../components/country-filter';

/**
 * The event moderation queue.
 *
 * ── WHAT A MODERATOR ACTUALLY NEEDS ────────────────────────────────────────────────
 * The list showed the category and the date the ROW was last edited. Neither answers the
 * question being asked. A moderator is deciding about something that happens on a date: whether
 * it is next week or went by a fortnight ago changes what the decision even means, and "updated
 * 19 September" says nothing about it. The category is worth a line under the title, not a
 * column of its own.
 *
 * The search box also filtered the fetched page in the browser, so an event on page two could
 * not be found by typing its name. It reaches the database now.
 */
const STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'PUBLISHED',
  'PAUSED',
  'SOLD_OUT',
  'CANCELLED',
  'COMPLETED',
  'ARCHIVED',
];

/**
 * When this event is, in the words somebody uses about it.
 *
 * One session is a date. Several is a run, which is a start and an end. None at all means
 * nobody can buy a ticket to it, and that is the most important thing this cell can say.
 */
function whenItHappens(e: AdminEventRow): { line: string; past: boolean; broken: boolean } {
  if (e.sessionCount === 0 || !e.firstSessionAt) {
    return { line: 'No dates set', past: false, broken: true };
  }
  const first = new Date(e.firstSessionAt);
  const last = e.lastSessionAt ? new Date(e.lastSessionAt) : first;
  const past = last.getTime() < Date.now();
  if (e.sessionCount === 1) return { line: dateOnly(e.firstSessionAt), past, broken: false };
  return {
    line: `${dateOnly(e.firstSessionAt)} to ${dateOnly(e.lastSessionAt ?? e.firstSessionAt)}`,
    past,
    broken: false,
  };
}

export default function AdminEventsPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState<GroupSelection>({});
  /*
    The status this page opens on can be named in the link.

    The action centre on the landing page counts each queue and links straight to it. Those
    links were landing on an UNFILTERED list, so "5 events waiting for review" took an operator to a
    page where they had to find those rows again - which is the work the count existed to
    save. The same failing as the search boxes that only ever searched the page you were on.

    Seeded once, then editable: the filter is still a control, not a property of the URL.
  */
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? 'UNDER_REVIEW');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [country, setCountryParam] = useCountryParam();
  const setCountry = (code: string | undefined) => {
    setCountryParam(code);
    setPage(1);
  };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'events', page, status, applied, country, group.groupBy, group.groupKey],
    queryFn: () =>
      api.admin.events({
        page,
        pageSize: 15,
        ...group,
        status: status || undefined,
        q: applied || undefined,
        country,
      }),
  });

  const columns: Column<AdminEventRow>[] = [
    {
      key: 'title',
      header: 'Event',
      render: (e) => (
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-text-primary">{e.title}</p>
          <p className="text-caption text-text-secondary">
            {e.organization.name} · {e.venue.city}
          </p>
          <p className="text-caption text-text-muted">{e.category}</p>
        </div>
      ),
    },
    {
      key: 'country',
      header: 'Country',
      render: (e) => <CountryLabel stored={e.venue.country} />,
    },
    {
      key: 'when',
      header: 'When',
      className: 'whitespace-nowrap',
      render: (e) => {
        const when = whenItHappens(e);
        return (
          <div className="space-y-1">
            <p
              className={
                when.broken
                  ? 'text-status-warning'
                  : when.past
                    ? 'text-text-muted'
                    : 'text-text-primary'
              }
            >
              {when.line}
            </p>
            {e.sessionCount > 1 && (
              <p className="text-caption text-text-muted">{e.sessionCount} shows</p>
            )}
            {/* An event nobody can buy a ticket to looks identical to a healthy one otherwise. */}
            {when.broken && <p className="text-caption text-text-muted">Nothing to sell yet</p>}
          </div>
        );
      },
      sortable: true,
      sortValue: (e) => e.firstSessionAt ?? '',
    },
    {
      key: 'status',
      header: 'Status',
      className: 'whitespace-nowrap',
      render: (e) => (
        <div className="space-y-1">
          <StatusBadge status={e.status} />
          <p className="text-caption text-text-muted">Edited {dateOnly(e.updatedAt)}</p>
        </div>
      ),
      sortable: true,
      sortValue: (e) => e.updatedAt,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Events"
        description="Everything on sale across the platform, and everything waiting on a decision."
      />

      <Card>
        <div className="grid gap-3 sm:grid-cols-[1fr_200px_200px]">
          <SearchInput
            value={q}
            onChange={setQ}
            onSubmit={() => {
              setApplied(q.trim());
              setPage(1);
            }}
            placeholder="Search title, organizer or city"
          />
          <Select
            aria-label="Status filter"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Every status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase().replaceAll('_', ' ')}
              </option>
            ))}
          </Select>
          <CountryFilter value={country} onChange={setCountry} />
        </div>
      </Card>

      <Card
        title={status === 'UNDER_REVIEW' ? 'Waiting for a decision' : 'Events'}
        action={data ? <Badge tone="neutral">{data.meta.total} matching</Badge> : undefined}
      >
        <GroupedSummary
          resource="events"
          options={['country', 'organizer']}
          value={group}
          status={status || undefined}
          q={applied || undefined}
          country={country}
          onChange={(next) => {
            // Page 1: the page number belonged to the previous scope, and page 4 of a group with
            // two rows is an empty table that looks like "no results".
            setGroup(next);
            setPage(1);
          }}
        />
        <DataTable
          columns={columns}
          rows={data?.data}
          loading={isLoading}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
          empty={
            <EmptyState
              title={status === 'UNDER_REVIEW' ? 'Nothing waiting for review' : 'No event matches'}
              hint={
                status === 'UNDER_REVIEW'
                  ? 'Every event submitted has been decided. Change the status filter to see the rest.'
                  : 'Try clearing the status filter, or search by organizer.'
              }
            />
          }
          rowKey={(e) => e.id}
          onRowClick={(e) => router.push(`/admin/events/${e.id}`)}
        />
        {data && data.meta.totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              onChange={setPage}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
