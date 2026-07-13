'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  Textarea,
  Skeleton,
  ErrorState,
  useToast,
  errorMessage,
} from '@eticketsgo/web-kit';

const EDITABLE = ['DRAFT', 'UNDER_REVIEW', 'PAUSED'];
const FEE_MODES = ['CUSTOMER_PAYS', 'ORGANIZER_PAYS', 'SHARED'];

export default function EditEvent() {
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

  const [form, setForm] = useState({
    title: '',
    category: '',
    description: '',
    refundPolicy: '',
    feeMode: 'CUSTOMER_PAYS',
  });

  useEffect(() => {
    if (event)
      setForm({
        title: event.title,
        category: event.category,
        description: event.description ?? '',
        refundPolicy: event.refundPolicy ?? '',
        feeMode: event.feeMode,
      });
  }, [event]);

  const save = useMutation({
    mutationFn: () =>
      api.events.update(id, {
        title: form.title,
        category: form.category,
        description: form.description || undefined,
        refundPolicy: form.refundPolicy || undefined,
        feeMode: form.feeMode,
      }),
    onSuccess: () => {
      toast.push('Event updated.', 'success');
      qc.invalidateQueries({ queryKey: ['event', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !event) return <Skeleton className="h-64 w-full" />;
  const editable = EDITABLE.includes(event.status);

  return (
    <Card className="max-w-2xl">
      {!editable && (
        <p className="mb-4 rounded-md bg-status-warning/10 p-3 text-sm text-status-warning">
          This event is {event.status.toLowerCase()} and cannot be edited. Pause it first to make
          changes.
        </p>
      )}
      <div className="space-y-4">
        <Input
          id="title"
          label="Title"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          disabled={!editable}
        />
        <Input
          id="category"
          label="Category"
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          disabled={!editable}
        />
        <Textarea
          id="desc"
          label="Description"
          rows={4}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          disabled={!editable}
        />
        <Textarea
          id="refund"
          label="Refund policy"
          rows={2}
          value={form.refundPolicy}
          onChange={(e) => setForm({ ...form, refundPolicy: e.target.value })}
          disabled={!editable}
        />
        <Select
          id="fee"
          label="Fee handling"
          value={form.feeMode}
          onChange={(e) => setForm({ ...form, feeMode: e.target.value })}
          disabled={!editable}
        >
          {FEE_MODES.map((f) => (
            <option key={f} value={f}>
              {f.replaceAll('_', ' ')}
            </option>
          ))}
        </Select>
        <Button loading={save.isPending} disabled={!editable} onClick={() => save.mutate()}>
          Save changes
        </Button>
      </div>
    </Card>
  );
}
