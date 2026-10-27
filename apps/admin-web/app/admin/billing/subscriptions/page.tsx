'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  api,
  Card,
  DataTable,
  EmptyState,
  Input,
  PageHeader,
  Pagination,
  Select,
  money,
  type AdminSubscriptionRow,
  type Column,
} from '@eticketsgo/web-kit';
import { SubscriptionStatusBadge, day } from '@/components/billing/billing-ui';
import {
  INTERVAL_WORDS,
  PLAN_WORDS,
  SUBSCRIPTION_STATUSES,
  planWords,
  subscriptionSourceWords,
  subscriptionStatusWords,
} from '@/lib/billing';

const PAGE_SIZE = 25;

/**
 * Subscriptions: every organization's plan, searched and paged by the server.
 *
 * "Current only" is on by default, so each organization shows once. Turn it off to see the
 * history too (ended trials, cancelled plans).
 */
export default function BillingSubscriptionsPage() {
  const [status, setStatus] = useState('');
  const [plan, setPlan] = useState('');
  const [country, setCountry] = useState('');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [currentOnly, setCurrentOnly] = useState(true);
  const [page, setPage] = useState(1);

  // Search after typing stops, not on every key.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchText.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const params = {
    status: status || undefined,
    planCode: plan || undefined,
    country: country.trim().toUpperCase() || undefined,
    search: search || undefined,
    currentOnly: (currentOnly ? 'true' : 'false') as 'true' | 'false',
    page,
    pageSize: PAGE_SIZE,
  };
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'billing', 'subscriptions', params],
    queryFn: () => api.admin.billing.subscriptions(params),
  });
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = !!(status || plan || country.trim() || search);

  const columns: Column<AdminSubscriptionRow>[] = [
    {
      key: 'org',
      header: 'Organization',
      render: (r) => (
        <Link
          className="font-medium text-text-primary underline-offset-2 hover:underline"
          href={`/admin/billing/accounts/${encodeURIComponent(r.organizationId)}`}
        >
          {r.organizationName ?? r.organizationId}
        </Link>
      ),
    },
    { key: 'country', header: 'Country', render: (r) => r.country },
    { key: 'plan', header: 'Plan', render: (r) => planWords(r.planCode) },
    {
      key: 'status',
      header: 'State',
      render: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <SubscriptionStatusBadge status={r.status} />
          {!r.current && <span className="text-caption text-text-muted">Past</span>}
        </span>
      ),
    },
    { key: 'source', header: 'How', render: (r) => subscriptionSourceWords(r.source) },
    {
      key: 'price',
      header: 'Price',
      className: 'whitespace-nowrap',
      render: (r) =>
        r.price
          ? `${money(r.price.amountMinor, r.price.currency)} ${INTERVAL_WORDS[r.price.interval].toLowerCase()}`
          : '-',
    },
    {
      key: 'ends',
      header: 'Ends',
      className: 'whitespace-nowrap',
      render: (r) => day(r.status === 'TRIALING' ? r.trialEndsAt : r.currentPeriodEnd),
    },
    {
      key: 'since',
      header: 'Started',
      className: 'whitespace-nowrap',
      render: (r) => day(r.createdAt),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subscriptions"
        description="Which plan each organization is on. Open one to give a trial, credits or a feature."
      />
      <Card padding="md">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input
            label="Search"
            placeholder="Organization name or id"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <Select
            label="State"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any state</option>
            {SUBSCRIPTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {subscriptionStatusWords(s)}
              </option>
            ))}
          </Select>
          <Select
            label="Plan"
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any plan</option>
            {Object.entries(PLAN_WORDS).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
          <Input
            label="Country"
            placeholder="IN"
            maxLength={2}
            value={country}
            onChange={(e) => {
              setCountry(e.target.value);
              setPage(1);
            }}
          />
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={currentOnly}
              onChange={(e) => {
                setCurrentOnly(e.target.checked);
                setPage(1);
              }}
            />
            Current only
          </label>
        </div>
      </Card>
      <Card>
        <DataTable
          columns={columns}
          rows={data?.items}
          loading={isLoading}
          error={isError ? 'We could not load the subscriptions.' : undefined}
          onRetry={() => refetch()}
          rowKey={(r) => r.id}
          mobile="cards"
          empty={
            <EmptyState
              compact
              title={filtered ? 'No subscriptions match' : 'No subscriptions yet'}
              hint={
                filtered
                  ? 'Try fewer filters.'
                  : 'An organization with no subscription is on the Free plan.'
              }
            />
          }
        />
        {data && (
          <div className="mt-4 space-y-3">
            <p className="text-caption text-text-muted">{data.total} in all.</p>
            <Pagination page={data.page} totalPages={totalPages} onChange={setPage} />
          </div>
        )}
      </Card>
    </div>
  );
}
