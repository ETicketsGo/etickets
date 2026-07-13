'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Textarea,
  DataTable,
  StatusBadge,
  Skeleton,
  PageHeader,
  ErrorState,
  useToast,
  errorMessage,
  dateOnly,
  type Column,
  type OrgMember,
} from '@eticketsgo/web-kit';

export default function OrganizerDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');

  const orgQ = useQuery({ queryKey: ['org', id], queryFn: () => api.organizations.get(id) });
  const membersQ = useQuery({
    queryKey: ['org', id, 'members'],
    queryFn: () => api.organizations.members(id),
  });

  const review = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api.admin.reviewOrganizer(id, decision, note || undefined),
    onSuccess: (_res, decision) => {
      toast.push(`Organizer ${decision === 'APPROVE' ? 'approved' : 'rejected'}.`, 'success');
      qc.invalidateQueries({ queryKey: ['org', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const org = orgQ.data;
  const columns: Column<OrgMember>[] = [
    { key: 'name', header: 'Name', render: (m) => m.user.fullName },
    { key: 'email', header: 'Email', render: (m) => m.user.email },
    { key: 'role', header: 'Role', render: (m) => m.role.replaceAll('_', ' ') },
    { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
  ];

  if (orgQ.isError)
    return (
      <ErrorState
        message="We couldn't load this. Please try again."
        onRetry={() => orgQ.refetch()}
      />
    );
  if (orgQ.isLoading || !org) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={org.name}
        breadcrumbs={[{ label: 'Organizers', href: '/admin/organizers' }, { label: org.name }]}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-y-3 text-sm">
            <dt className="text-text-muted">Status</dt>
            <dd>
              <StatusBadge status={org.status} />
            </dd>
            <dt className="text-text-muted">Contact</dt>
            <dd className="text-text-primary">{org.contactEmail ?? '—'}</dd>
            <dt className="text-text-muted">Events</dt>
            <dd className="text-text-primary">{org._count?.events ?? 0}</dd>
            <dt className="text-text-muted">Members</dt>
            <dd className="text-text-primary">{org._count?.members ?? 0}</dd>
            <dt className="text-text-muted">Joined</dt>
            <dd className="text-text-primary">{dateOnly(org.createdAt)}</dd>
          </dl>
        </Card>

        <Card title="Review">
          {org.status === 'PENDING' ? (
            <div className="space-y-3">
              <Textarea
                id="note"
                label="Note (optional)"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  loading={review.isPending && review.variables === 'APPROVE'}
                  disabled={review.isPending}
                  onClick={() => review.mutate('APPROVE')}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  loading={review.isPending && review.variables === 'REJECT'}
                  disabled={review.isPending}
                  onClick={() => review.mutate('REJECT')}
                >
                  Reject
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-text-muted">This organizer is {org.status.toLowerCase()}.</p>
          )}
        </Card>
      </div>

      <Card title="Team">
        <DataTable
          columns={columns}
          rows={membersQ.data}
          loading={membersQ.isLoading}
          rowKey={(m) => m.id}
        />
      </Card>
    </div>
  );
}
