'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  DataTable,
  StatusBadge,
  useToast,
  errorMessage,
  dateTime,
  type Column,
  type EventSession,
} from '@eticketsgo/web-kit';

export default function SessionsTab() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });
  const [form, setForm] = useState({ startsAt: '', endsAt: '' });

  const add = useMutation({
    mutationFn: () =>
      api.events.addSession(id, {
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
      }),
    onSuccess: () => {
      toast.push('Session added.', 'success');
      setForm({ startsAt: '', endsAt: '' });
      qc.invalidateQueries({ queryKey: ['event', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<EventSession>[] = [
    { key: 'start', header: 'Starts', render: (s) => dateTime(s.startsAt) },
    { key: 'end', header: 'Ends', render: (s) => dateTime(s.endsAt) },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'tickets', header: 'Ticket types', render: (s) => s.ticketTypes?.length ?? 0 },
  ];

  const endBeforeStart =
    !!form.startsAt && !!form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt);
  const valid = !!form.startsAt && !!form.endsAt && !endBeforeStart;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <DataTable
          columns={columns}
          rows={event?.sessions}
          loading={isLoading}
          rowKey={(s) => s.id}
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
        />
      </div>
      <Card title="Add session">
        <div className="space-y-3">
          <Input
            id="s"
            label="Starts at"
            type="datetime-local"
            value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
          />
          <Input
            id="e"
            label="Ends at"
            type="datetime-local"
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
            error={endBeforeStart ? 'End must be after start.' : undefined}
          />
          <Button
            className="w-full"
            loading={add.isPending}
            disabled={!valid}
            onClick={() => add.mutate()}
          >
            Add session
          </Button>
        </div>
      </Card>
    </div>
  );
}
