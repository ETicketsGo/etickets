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
import { EVENT_CATEGORIES, isListedCategory } from '@/lib/templates';

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
    isFree: false,
  });
  /* Typed rather than picked, when the stored value is not one of the offered options. */
  const [categoryMode, setCategoryMode] = useState<'list' | 'other'>('list');

  useEffect(() => {
    if (event)
      setForm({
        title: event.title,
        category: event.category,
        description: event.description ?? '',
        refundPolicy: event.refundPolicy ?? '',
        feeMode: event.feeMode,
        isFree: event.isFree,
      });
    if (event) setCategoryMode(isListedCategory(event.category) ? 'list' : 'other');
  }, [event]);

  const save = useMutation({
    mutationFn: () =>
      api.events.update(id, {
        title: form.title,
        category: form.category,
        description: form.description || undefined,
        refundPolicy: form.refundPolicy || undefined,
        feeMode: form.feeMode,
        isFree: form.isFree,
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
  const hasBookings = event.sessions.some((sess) =>
    (sess.ticketTypes ?? []).some((t) => (t.inventory?.quantitySold ?? 0) > 0),
  );

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
        <Select
          id="category"
          label="Category"
          value={categoryMode === 'other' ? '__other' : form.category}
          disabled={!editable}
          onChange={(e) => {
            if (e.target.value === '__other') {
              setCategoryMode('other');
              setForm((f) => ({ ...f, category: '' }));
            } else {
              setCategoryMode('list');
              setForm((f) => ({ ...f, category: e.target.value }));
            }
          }}
        >
          <option value="">Select a category…</option>
          {EVENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="__other">Something else…</option>
        </Select>
        {categoryMode === 'other' && (
          <Input
            id="category-other"
            label="Your category"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            disabled={!editable}
          />
        )}
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
        {/*
          Switching between free and paid is refused by the API once anybody has booked, so
          the control is disabled with the reason rather than left to fail on save. A
          confirmed booking with no payment behind it cannot be re-read as a paid one.
        */}
        <label className="flex items-start gap-3 rounded-md border border-border p-3">
          <input
            id="is-free"
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={form.isFree}
            disabled={!editable || hasBookings}
            onChange={(e) => setForm({ ...form, isFree: e.target.checked })}
          />
          <span className="text-sm">
            <span className="font-medium">This is a free event</span>
            <span className="mt-1 block text-text-muted">
              {hasBookings
                ? 'This event already has bookings, so it can no longer be switched between free and paid.'
                : 'Nobody is charged, so there is no checkout, no booking fee and no platform share. Attendees still book, get tickets and QR codes, and can cancel.'}
            </span>
          </span>
        </label>
        {!form.isFree && (
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
        )}
        <Button loading={save.isPending} disabled={!editable} onClick={() => save.mutate()}>
          Save changes
        </Button>
      </div>
    </Card>
  );
}
