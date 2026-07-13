'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  DataTable,
  StatusBadge,
  Badge,
  Select,
  SearchInput,
  Pagination,
  PageHeader,
  EmptyState,
  dateOnly,
  type Column,
  type AdminUser,
} from '@eticketsgo/web-kit';

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
  const [applied, setApplied] = useState('');
  const [role, setRole] = useState('');
  const [userStatus, setUserStatus] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'users', page, applied],
    queryFn: () => api.users.adminList({ page, pageSize: 20, q: applied || undefined }),
  });

  const rows = data?.data.filter(
    (u) =>
      (!role || u.roles.includes(role)) && (!userStatus || u.status === userStatus),
  );

  const columns: Column<AdminUser>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (u) => <span className="font-medium text-text-primary">{u.fullName}</span>,
    },
    { key: 'email', header: 'Email', render: (u) => u.email },
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
    { key: 'status', header: 'Status', render: (u) => <StatusBadge status={u.status} /> },
    { key: 'joined', header: 'Joined', render: (u) => dateOnly(u.createdAt) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Users" description="Search accounts and inspect roles." />
      <div className="grid gap-3 sm:grid-cols-[1fr_180px_180px]">
        <SearchInput
          value={q}
          onChange={setQ}
          onSubmit={() => {
            setApplied(q);
            setPage(1);
          }}
          placeholder="Search name or email…"
        />
        <Select
          aria-label="Role filter"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r.replaceAll('_', ' ')}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Status filter"
          value={userStatus}
          onChange={(e) => setUserStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {USER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        loading={isLoading}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={<EmptyState title="No users match these filters" />}
        rowKey={(u) => u.id}
      />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
