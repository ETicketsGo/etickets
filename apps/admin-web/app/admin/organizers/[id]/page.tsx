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
import { LegalIdentityCard } from '@/components/legal-identity-card';

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

  /*
    Trusting this organizer to publish without review.

    The API decides whether it is allowed — an organizer that is not APPROVED, or has never
    had an event approved the ordinary way, is refused. Its refusal is SHOWN rather than
    pre-empted with a disabled control: "this organizer has never had an event approved,
    review their first one then turn this on" explains what trust means here, and a greyed-out
    switch explains nothing.
  */
  const autoApprove = useMutation({
    mutationFn: (enabled: boolean) => api.admin.setOrganizerAutoApprove(id, enabled),
    onSuccess: (res) => {
      toast.push(
        res.autoApproveEvents
          ? 'Their events will now go live without review.'
          : 'Their events will go back through review.',
        'success',
      );
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

        <Card title="Publishing">
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {org.autoApproveEvents
                ? 'Their events go live the moment they are submitted. Nobody reviews them.'
                : 'Every event they submit waits for a reviewer before it can sell a ticket.'}
            </p>
            <p className="text-caption text-text-muted">
              {/*
                Both halves stated, because the reason to hesitate and the reason to do it are
                the same fact seen from two sides.
              */}
              Turn this on for organizers you know. It removes a delay on every event they run — and
              it removes the check that would catch a wrong venue or a mistyped price before
              somebody buys a ticket.
            </p>
            <Button
              variant={org.autoApproveEvents ? 'danger' : 'primary'}
              loading={autoApprove.isPending}
              disabled={autoApprove.isPending}
              onClick={() => autoApprove.mutate(!org.autoApproveEvents)}
            >
              {org.autoApproveEvents ? 'Send their events back to review' : 'Skip review for them'}
            </Button>
          </div>
        </Card>
      </div>

      {/* Beside Review and Publishing, because recording a seller's registration is part of
          onboarding them — not a settings detail to be found later. */}
      <LegalIdentityCard organizationId={id} />

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
