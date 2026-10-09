'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  MetricCard,
  Pagination,
  PageHeader,
  SearchInput,
  Select,
  Skeleton,
  StatusBadge,
  adminContact,
  dateOnly,
  marketFor,
  type AdminUser,
  type Column,
  type UserDirectoryFilters,
} from '@eticketsgo/web-kit';
import { AccountContact } from '../../../components/account-contact';
import {
  CountryFilter,
  CountryLabel,
  countryPhrase,
  useCountryParam,
} from '../../../components/country-filter';

/**
 * The account directory, read by country first.
 *
 * ── TWO THINGS WERE WRONG, NOT ONE ─────────────────────────────────────────────────
 * Asked for: users listed by country. The page had no country at all, and it also had a filter
 * that did not work - role and status were applied in the browser to the twenty rows already
 * fetched, so "show me the suspended accounts" returned the suspended accounts AMONG THOSE
 * TWENTY, under a pager that still counted the whole directory. Both are fixed in the database.
 *
 * ── WHERE THE COUNTRY COMES FROM ───────────────────────────────────────────────────
 * Not from the account: nobody is asked at sign-up, a locale is a language setting, and a phone
 * calling code cannot tell the United States from Canada. It comes from what the account did -
 * the countries of the venues it bought at, and of the organizations it belongs to. An account
 * with neither is counted as "country not known", said out loud rather than guessed at.
 */
const ROLES = [
  'CUSTOMER',
  'ORGANIZER_OWNER',
  'ORGANIZER_MANAGER',
  'CHECKIN_STAFF',
  'ADMIN',
  'SUPER_ADMIN',
];
const USER_STATUSES = ['ACTIVE', 'SUSPENDED'];

export default function AdminUsers() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  // Role, status and search are local; the country is in the URL (see `useCountryParam`).
  const [local, setLocal] = useState<Omit<UserDirectoryFilters, 'country'>>({});
  const [country, setCountryParam] = useCountryParam();
  const filters: UserDirectoryFilters = { ...local, country };
  const set = (patch: Omit<UserDirectoryFilters, 'country'>) => {
    setLocal((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const setCountry = (code: string | undefined) => {
    setCountryParam(code);
    setPage(1);
  };

  /*
    The summary is the whole directory, never narrowed by the filters. It is the map somebody
    reads to decide what to filter BY, and a map that redraws itself around the pin you just
    dropped is no use for finding the next one.
  */
  const summary = useQuery({
    queryKey: ['admin', 'user-directory-summary'],
    queryFn: () => api.users.directorySummary(),
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'users', page, filters],
    queryFn: () => api.users.adminList({ page, pageSize: 25, ...filters }),
  });

  const columns: Column<AdminUser>[] = [
    {
      key: 'person',
      header: 'Account',
      render: (u) => {
        /*
          A phone-only account has no name and a placeholder for an email. It is shown by its
          number, labelled, rather than as a blank name over an address nobody can write to.
        */
        const name = u.fullName?.trim();
        const contact = adminContact(u.email, u.phone);
        return (
          <div className="min-w-0 space-y-0.5">
            {name ? (
              <>
                <p className="font-medium text-text-primary">{name}</p>
                <AccountContact
                  email={u.email}
                  phone={u.phone}
                  className="text-caption text-text-muted"
                />
              </>
            ) : (
              <>
                <p className="whitespace-nowrap font-medium tabular-nums text-text-primary">
                  {contact?.text ?? 'No name'}
                </p>
                {contact?.phoneSignIn && <Badge tone="neutral">Phone sign-in</Badge>}
              </>
            )}
          </div>
        );
      },
    },
    {
      key: 'countries',
      header: 'Country',
      render: (u) =>
        u.countries.length === 0 ? (
          <span className="text-caption text-text-muted">Not known</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {u.countries.map((c) => (
              <CountryLabel key={c} stored={c} />
            ))}
          </div>
        ),
    },
    {
      key: 'roles',
      header: 'Roles',
      render: (u) => (
        <div className="flex flex-wrap gap-1">
          {u.roles.map((r) => (
            <Badge key={r} tone="neutral">
              {r.replaceAll('_', ' ')}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      className: 'whitespace-nowrap',
      render: (u) => (
        <div className="space-y-1">
          <StatusBadge status={u.status} />
          <p className="text-caption text-text-muted">Joined {dateOnly(u.createdAt)}</p>
        </div>
      ),
    },
  ];

  const filtered = Boolean(filters.country || filters.role || filters.status || filters.q);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounts"
        description="Everybody with a login: customers, organizer teams and platform staff."
      />

      {summary.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        summary.data && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <MetricCard label="Accounts" value={String(summary.data.total)} />
              <MetricCard
                label="Countries active in"
                value={String(summary.data.byCountry.length)}
                hint="Where an account has bought, or belongs to an organizer"
              />
              <MetricCard
                label="Country not known"
                value={String(summary.data.withoutCountry)}
                hint="No booking and no organization yet"
                tone="neutral"
              />
            </div>

            <Card title="By country">
              {/*
                Clickable, because a count nobody can act on is decoration. Each one filters the
                list below, and pressing it again clears it.
              */}
              {summary.data.byCountry.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No account has bought a ticket or joined an organizer yet, so no country can be
                  derived for anybody.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {summary.data.byCountry.map((c) => {
                    /*
                      The chip filters by the market's CODE, the same value the dropdown and the
                      link carry. A country this platform has no market for cannot be put in a
                      link, so its count is shown without being a button.
                    */
                    const code = marketFor(c.country)?.code;
                    const selected = Boolean(code) && country === code;
                    if (!code) {
                      return (
                        <span
                          key={c.country}
                          className="rounded-full border border-border px-3 py-1.5 text-sm text-text-secondary"
                        >
                          {c.country}{' '}
                          <span className="tabular-nums text-text-muted">{c.count}</span>
                        </span>
                      );
                    }
                    return (
                      <button
                        key={c.country}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setCountry(selected ? undefined : code)}
                        className={`rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                          selected
                            ? 'border-action-primary bg-tint-primary font-medium text-action-primary'
                            : 'border-border text-text-secondary hover:bg-background-subtle hover:text-text-primary'
                        }`}
                      >
                        {c.country} <span className="tabular-nums text-text-muted">{c.count}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="mt-3 text-caption text-text-muted">
                An account active in two countries is counted in both, so these can add up to more
                than the number of accounts.
              </p>
            </Card>
          </>
        )
      )}

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_180px_180px_180px_auto]">
          <SearchInput
            value={q}
            onChange={setQ}
            onSubmit={() => set({ q: q || undefined })}
            placeholder="Search name, email or phone"
          />
          <CountryFilter value={country} onChange={setCountry} />
          <Select
            aria-label="Role filter"
            value={filters.role ?? ''}
            onChange={(e) => set({ role: e.target.value || undefined })}
          >
            <option value="">Every role</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r.replaceAll('_', ' ')}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Status filter"
            value={filters.status ?? ''}
            onChange={(e) => set({ status: e.target.value || undefined })}
          >
            <option value="">Every status</option>
            {USER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === 'ACTIVE' ? 'Active' : 'Suspended'}
              </option>
            ))}
          </Select>
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => {
                setQ('');
                setLocal({});
                setCountry(undefined);
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </Card>

      <Card
        title={country ? `Accounts${countryPhrase(country)}` : 'All accounts'}
        action={data ? <Badge tone="neutral">{data.meta.total} matching</Badge> : undefined}
      >
        <DataTable
          columns={columns}
          rows={data?.data}
          loading={isLoading}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
          empty={
            <EmptyState
              title="No account matches"
              hint="Try clearing a filter, or search by email or phone number instead."
            />
          }
          rowKey={(u) => u.id}
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
