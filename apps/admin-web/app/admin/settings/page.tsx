'use client';

import { useQuery } from '@tanstack/react-query';
import {
  api,
  Card,
  DataTable,
  PageHeader,
  money,
  type Column,
  type FeeRule,
} from '@eticketsgo/web-kit';

export default function AdminSettings() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'fee-rules'],
    queryFn: () => api.admin.feeRules(),
  });

  const columns: Column<FeeRule>[] = [
    { key: 'label', header: 'Band', render: (r) => r.label },
    { key: 'min', header: 'From', render: (r) => money(r.minMinor) },
    {
      key: 'max',
      header: 'To',
      render: (r) => (r.maxMinor == null ? 'and above' : money(r.maxMinor)),
    },
    { key: 'fee', header: 'Booking fee', render: (r) => money(r.feeMinor) },
    { key: 'active', header: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Platform fee configuration." />
      <Card title="Booking fee rules">
        <DataTable columns={columns} rows={data} loading={isLoading} rowKey={(r) => r.id} />
        <p className="mt-3 text-xs text-text-muted">
          Fee rules are seeded from the India defaults. Editing rules from the UI requires a
          fee-rule write endpoint (<code>PATCH /admin/fee-rules/:id</code>), which is not yet
          implemented on the API.
        </p>
      </Card>
    </div>
  );
}
