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
  titleCase,
  type Column,
  type Organization,
} from '@eticketsgo/web-kit';
import { CountryFilter, CountryLabel, useCountryParam } from '../../../components/country-filter';

/**
 * The organizer queue.
 *
 * ── WHAT WAS WRONG WITH IT ─────────────────────────────────────────────────────────
 * Three things, all of which made it read like a list rather than a queue:
 *
 *  - The search box filtered the FETCHED PAGE in the browser. Typing a name that was on page
 *    two returned "no organizers match" while the pager underneath still counted every one.
 *  - A column headed "Review" showed the words "Reviewed" and "Skips review" in grey. It names
 *    a flag rather than saying what the flag DOES, and both readings look like the same thing
 *    happened rather than opposite futures.
 *  - Two organizations can be called the same thing, and the list had nothing to tell them
 *    apart: the same name twice, one pending and one approved, with no way to know which is
 *    which until you open both.
 */
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'];

export default function OrganizersPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState<GroupSelection>({});
  /*
    The status this page opens on can be named in the link.

    The action centre on the landing page counts each queue and links straight to it. Those
    links were landing on an UNFILTERED list, so "3 organizers waiting to be approved" took an operator to a
    page where they had to find those rows again - which is the work the count existed to
    save. The same failing as the search boxes that only ever searched the page you were on.

    Seeded once, then editable: the filter is still a control, not a property of the URL.
  */
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [country, setCountryParam] = useCountryParam();
  const setCountry = (code: string | undefined) => {
    setCountryParam(code);
    setPage(1);
  };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [
      'admin',
      'organizers',
      page,
      status,
      applied,
      country,
      group.groupBy,
      group.groupKey,
    ],
    queryFn: () =>
      api.admin.organizers({
        page,
        pageSize: 15,
        ...group,
        status: status || undefined,
        q: applied || undefined,
        country,
      }),
  });

  const columns: Column<Organization>[] = [
    {
      key: 'name',
      header: 'Organization',
      render: (o) => (
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-text-primary">{o.name}</p>
          {/*
            The slug, because the name is not unique and the list had nothing else to go on.
            It is also what appears in their public URL, so it is the thing somebody can check.
          */}
          <p className="font-mono text-caption text-text-muted">{o.slug}</p>
          {(o.openComplaints ?? 0) > 0 && (
            <p className="text-caption text-status-error">
              {o.openComplaints} open complaint{o.openComplaints === 1 ? '' : 's'}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'country',
      // Where the business is registered - the country approval collects.
      header: 'Country',
      render: (o) => <CountryLabel stored={o.registeredCountry} />,
    },
    {
      key: 'status',
      header: 'Status',
      className: 'whitespace-nowrap',
      render: (o) => (
        <div className="space-y-1">
          <StatusBadge status={o.status} />
          <p className="text-caption text-text-muted">Joined {dateOnly(o.createdAt)}</p>
        </div>
      ),
    },
    {
      key: 'review',
      /*
        The header asks the question and the cell answers it.

        "Review / Skips review" named the setting; this names the consequence, which is the only
        thing a reader of this queue needs to know about it. The tone matters too: an organizer
        publishing without a reviewer is a standing decision somebody made, not a neutral fact.
      */
      header: 'New events',
      className: 'whitespace-nowrap',
      render: (o) =>
        o.autoApproveEvents ? (
          <Badge tone="warning">Go live at once</Badge>
        ) : (
          <Badge tone="neutral">Wait for review</Badge>
        ),
    },
    {
      key: 'size',
      header: 'Size',
      className: 'whitespace-nowrap',
      render: (o) => (
        <div className="space-y-1 text-caption text-text-secondary">
          <p>
            {o._count?.events ?? 0} event{(o._count?.events ?? 0) === 1 ? '' : 's'}
          </p>
          <p className="text-text-muted">
            {o._count?.members ?? 0} member{(o._count?.members ?? 0) === 1 ? '' : 's'}
          </p>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organizers"
        description="Everybody who sells on the platform, and whether they may keep doing it."
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
            placeholder="Search name, slug or registered legal name"
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
                {titleCase(s)}
              </option>
            ))}
          </Select>
          <CountryFilter value={country} onChange={setCountry} />
        </div>
      </Card>

      <Card
        title={status ? `${titleCase(status)} organizers` : 'All organizers'}
        action={data ? <Badge tone="neutral">{data.meta.total} matching</Badge> : undefined}
      >
        <GroupedSummary
          resource="organizers"
          options={['country']}
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
              title="No organizer matches"
              hint="Try clearing the status filter, or search by slug."
            />
          }
          rowKey={(o) => o.id}
          onRowClick={(o) => router.push(`/admin/organizers/${o.id}`)}
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
