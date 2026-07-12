'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  DataTable,
  StatusBadge,
  Badge,
  SearchInput,
  Pagination,
  PageHeader,
  dateOnly,
  type Column,
  type AdminUser,
} from '@eticketsgo/web-kit';

export default function AdminUsers() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', page, applied],
    queryFn: () => api.users.adminList({ page, pageSize: 20, q: applied || undefined }),
  });

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
      <div className="max-w-md">
        <SearchInput
          value={q}
          onChange={setQ}
          onSubmit={() => {
            setApplied(q);
            setPage(1);
          }}
          placeholder="Search name or email…"
        />
      </div>
      <DataTable columns={columns} rows={data?.data} loading={isLoading} rowKey={(u) => u.id} />
      {data && (
        <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onChange={setPage} />
      )}
    </div>
  );
}
