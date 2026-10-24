'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
  SegmentedControl,
  Select,
  errorMessage,
  recordedAt,
  useToast,
  type Column,
  type CrmFollowUp,
} from '@eticketsgo/web-kit';
import { CrmGate, NoTeamNotice, StageBadge, useCrmMe } from '../../../../components/crm/crm-ui';
import { followUpState } from '../../../../lib/crm';

type When = 'overdue' | 'today' | 'upcoming' | 'done';

/**
 * Follow-ups: what is late, what is due in the next day, what comes after, and what was done.
 *
 * An agent sees their own; a manager sees the team's and can narrow to one person. Done and
 * Cancel send the version this page read, so two people closing the same follow-up cannot both
 * succeed.
 */
export default function FollowUpsPage() {
  return (
    <CrmGate>
      <FollowUps />
    </CrmGate>
  );
}

function FollowUps() {
  const { me, access } = useCrmMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [when, setWhen] = useState<When>('overdue');
  const [owner, setOwner] = useState('me');
  const [page, setPage] = useState(1);
  const params = {
    page,
    pageSize: 25,
    status: when === 'done' ? 'DONE' : 'OPEN',
    when: when === 'done' ? 'all' : when,
    owner: owner || undefined,
  };
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['crm', 'follow-ups', params],
    queryFn: () => api.admin.crm.followUps(params),
  });
  const close = useMutation({
    mutationFn: (f: CrmFollowUp) => api.admin.crm.completeFollowUp(f.id, { version: f.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm'] });
      toast.push('Marked done.', 'success');
    },
    onError: (e) => {
      toast.push(errorMessage(e), 'error');
      refetch();
    },
  });

  const columns: Column<CrmFollowUp>[] = [
    {
      key: 'due',
      header: 'Due',
      className: 'whitespace-nowrap',
      render: (f) => (
        <span
          className={
            f.status === 'OPEN' && followUpState(f.dueAt) === 'overdue'
              ? 'font-medium text-status-error'
              : 'text-text-secondary'
          }
        >
          {recordedAt(f.dueAt)}
        </span>
      ),
    },
    {
      key: 'lead',
      header: 'Lead',
      render: (f) => (
        <div className="space-y-1">
          <Link
            className="font-medium text-text-primary underline-offset-2 hover:underline"
            href={`/admin/acquisition/prospects/${f.leadId}`}
          >
            {f.lead?.organizationName ?? 'Lead'}
          </Link>
          {f.lead && (
            <div>
              <StageBadge stage={f.lead.stage} />
            </div>
          )}
        </div>
      ),
    },
    { key: 'what', header: 'What to do', render: (f) => <span>{f.title}</span> },
    {
      key: 'owner',
      header: 'Whose',
      className: 'whitespace-nowrap',
      render: (f) => <span className="text-text-secondary">{f.owner.fullName}</span>,
    },
    {
      key: 'act',
      header: '',
      render: (f) =>
        f.status === 'OPEN' ? (
          <Button
            size="sm"
            variant="outline"
            loading={close.isPending}
            onClick={() => close.mutate(f)}
          >
            Done
          </Button>
        ) : (
          <Badge tone="success">Done</Badge>
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Follow-ups" description="What to do next, and for whom." />
      <NoTeamNotice me={me} />
      <Card padding="md">
        <div className="flex flex-wrap items-end gap-3">
          <SegmentedControl<When>
            label="Which follow-ups"
            value={when}
            onChange={(v) => {
              setWhen(v);
              setPage(1);
            }}
            options={[
              { value: 'overdue', label: 'Overdue' },
              { value: 'today', label: 'Next 24 hours' },
              { value: 'upcoming', label: 'Upcoming' },
              { value: 'done', label: 'Done' },
            ]}
          />
          {access.manager && (
            <div className="w-48">
              <Select
                aria-label="Whose follow-ups"
                value={owner}
                onChange={(e) => {
                  setOwner(e.target.value);
                  setPage(1);
                }}
              >
                <option value="me">Mine</option>
                <option value="">Everybody on my teams</option>
              </Select>
            </div>
          )}
        </div>
      </Card>
      <Card>
        <DataTable
          columns={columns}
          rows={data?.data}
          loading={isLoading}
          error={isError ? 'We could not load the follow-ups.' : undefined}
          onRetry={() => refetch()}
          rowKey={(f) => f.id}
          mobile="cards"
          empty={
            <EmptyState
              compact
              title={when === 'overdue' ? 'Nothing overdue' : 'No follow-ups here'}
              hint="Follow-ups are scheduled from a lead, usually while logging an activity."
            />
          }
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
