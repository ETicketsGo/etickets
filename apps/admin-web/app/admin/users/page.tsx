'use client';

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
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
  adminContact,
  dateOnly,
  marketFor,
  type AdminUser,
  type Column,
  type UserDirectoryFilters,
} from '@eticketsgo/web-kit';
import { StatusBadge } from '@/components/status-badge';
import { roleWords } from '@/lib/words';
import { useHolds } from '@/lib/capabilities';
import { AccountActions } from '@/components/account-actions';
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
 * ── FOUR KINDS OF COUNTRY EVIDENCE, NEVER MIXED ────────────────────────────────────
 * "Country not known" used to be the answer for 7 of 8 production accounts, because the only
 * country shown was derived from bookings and organizer memberships. The platform knows more
 * than that, and each thing it knows means something different, so each is shown under its own
 * label and none is promoted into another:
 *   - Lives in: what the person chose in their profile. The only "residence" there is.
 *   - Phone: the verified number's calling code. +1 is the United States AND Canada, so it is
 *     shown as "+1 (US/CA)" and never as a country.
 *   - Detected: where the network placed the sign-up (edge header). A hint, labelled as one.
 *   - Active in: where the account bought, or belongs to an organizer (unchanged).
 * The country filter still filters by ACTIVITY, and says so.
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
  const maySuspend = useHolds('USER_SUSPEND');
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
      header: 'Country evidence',
      render: (u) => <CountryEvidence account={u} />,
    },
    {
      key: 'roles',
      header: 'Roles',
      render: (u) => (
        <div className="flex flex-wrap gap-1">
          {u.roles.map((r) => (
            <Badge key={r} tone="neutral">
              {roleWords(r)}
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
    /*
      Suspend, reinstate and sign out everywhere, only for an operator holding USER_SUSPEND. The
      column is not drawn at all without it: an empty column on every row reads as broken.
    */
    ...(maySuspend
      ? [
          {
            key: 'actions',
            header: 'Actions',
            render: (u: AdminUser) => <AccountActions account={u} />,
          },
        ]
      : []),
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
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="Accounts" value={String(summary.data.total)} />
              <MetricCard
                label="Countries active in"
                value={String(summary.data.byCountry.length)}
                hint="Where an account has bought, or belongs to an organizer"
              />
              <MetricCard
                label="No activity country yet"
                value={String(summary.data.withoutActivityCountry ?? summary.data.withoutCountry)}
                hint="No booking and no organizer with a country. Other evidence may still exist."
                tone="neutral"
              />
              {summary.data.withoutAnyCountryEvidence !== undefined && (
                <MetricCard
                  label="No country evidence at all"
                  value={String(summary.data.withoutAnyCountryEvidence)}
                  hint="No residence, no verified phone, no network country and no activity"
                  tone="neutral"
                />
              )}
            </div>

            {(summary.data.byPhoneCallingCode ||
              summary.data.byResidence ||
              summary.data.byDetected) && (
              <Card title="Other country evidence">
                <dl className="grid gap-4 sm:grid-cols-3">
                  <EvidenceCounts
                    term="Verified phone, by calling code"
                    note="A fact about the number. +1 is the US and Canada."
                    rows={(summary.data.byPhoneCallingCode ?? []).map((r) => ({
                      label: r.code,
                      count: r.count,
                    }))}
                  />
                  <EvidenceCounts
                    term="Lives in (chosen by the person)"
                    note="Only what the person picked in their profile."
                    rows={(summary.data.byResidence ?? []).map((r) => ({
                      label: r.country,
                      count: r.count,
                    }))}
                  />
                  <EvidenceCounts
                    term="Detected at sign-up (network)"
                    note="Where the network placed the sign-up. A hint, not a residence."
                    rows={(summary.data.byDetected ?? []).map((r) => ({
                      label: r.country,
                      count: r.count,
                    }))}
                  />
                </dl>
              </Card>
            )}

            <Card title="Active in, by country">
              {/*
                Clickable, because a count nobody can act on is decoration. Each one filters the
                list below, and pressing it again clears it.
              */}
              {summary.data.byCountry.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No account has bought a ticket or joined an organizer yet, so no activity country
                  can be derived for anybody.
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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_180px_180px_180px_auto]">
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
                {roleWords(r)}
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

/**
 * One account's country evidence, each kind under its own label. Never merged into one
 * "country": a calling code is not a residence, and a network hint is not either.
 */
function CountryEvidence({ account: u }: { account: AdminUser }) {
  const activity = u.activityCountries ?? u.countries;
  const lines: ReactNode[] = [];
  if (u.countryOfResidence) {
    lines.push(
      <p key="res" className="flex flex-wrap items-center gap-1 text-caption">
        <span className="text-text-muted">Lives in:</span>
        <CountryLabel stored={u.countryOfResidence} />
      </p>,
    );
  }
  if (u.phoneCallingCodeLabel) {
    lines.push(
      <p key="phone" className="text-caption text-text-secondary">
        <span className="text-text-muted">Phone:</span>{' '}
        <span className="tabular-nums">{u.phoneCallingCodeLabel}</span>
      </p>,
    );
  }
  if (u.detectedCountry) {
    lines.push(
      <p key="det" className="text-caption text-text-secondary">
        <span className="text-text-muted">Detected:</span>{' '}
        {`${u.detectedCountry} (${u.detectedCountrySource ?? 'network'})`}
      </p>,
    );
  }
  if (activity.length > 0) {
    lines.push(
      <div key="act" className="flex flex-wrap items-center gap-1 text-caption">
        <span className="text-text-muted">Active in:</span>
        {activity.map((c) => (
          <CountryLabel key={c} stored={c} />
        ))}
      </div>,
    );
  }
  if (lines.length === 0) {
    return <span className="text-caption text-text-muted">No country evidence</span>;
  }
  return <div className="space-y-0.5">{lines}</div>;
}

function EvidenceCounts({
  term,
  note,
  rows,
}: {
  term: string;
  note: string;
  rows: { label: string; count: number }[];
}) {
  return (
    <div className="space-y-1">
      <dt className="text-sm font-medium text-text-primary">{term}</dt>
      <dd className="text-sm text-text-secondary">
        {rows.length === 0 ? (
          <span className="text-text-muted">None yet</span>
        ) : (
          <span className="flex flex-wrap gap-2">
            {rows.map((r) => (
              <span
                key={r.label}
                className="rounded-full border border-border px-3 py-1 tabular-nums"
              >
                {r.label} <span className="text-text-muted">{r.count}</span>
              </span>
            ))}
          </span>
        )}
      </dd>
      <dd className="text-caption text-text-muted">{note}</dd>
    </div>
  );
}
