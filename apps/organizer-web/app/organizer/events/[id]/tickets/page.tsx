'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  EmptyState,
  Skeleton,
  ErrorState,
  useToast,
  errorMessage,
  money,
  dateTime,
} from '@eticketsgo/web-kit';

export default function TicketsTab() {
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
    eventSessionId: '',
    name: '',
    priceRupees: '',
    quantityTotal: '',
    maxPerOrder: '6',
  });

  const add = useMutation({
    mutationFn: () =>
      api.events.addTicketType({
        eventSessionId: form.eventSessionId,
        name: form.name,
        priceMinor: Math.round(Number(form.priceRupees) * 100),
        quantityTotal: Number(form.quantityTotal),
        maxPerOrder: Number(form.maxPerOrder) || 10,
      }),
    onSuccess: () => {
      toast.push('Ticket type added.', 'success');
      setForm({ ...form, name: '', priceRupees: '', quantityTotal: '' });
      qc.invalidateQueries({ queryKey: ['event', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !event) return <Skeleton className="h-64 w-full" />;

  const valid =
    form.eventSessionId && form.name && Number(form.quantityTotal) > 0 && form.priceRupees !== '';

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {event.sessions.length === 0 ? (
          <EmptyState title="Add a session first" hint="Ticket types belong to a session." />
        ) : (
          event.sessions.map((s) => (
            <Card key={s.id} title={dateTime(s.startsAt)}>
              {s.ticketTypes && s.ticketTypes.length > 0 ? (
                <ul className="divide-y divide-border text-sm">
                  {s.ticketTypes.map((t) => (
                    <li key={t.id} className="flex items-center justify-between py-2">
                      <span className="font-medium text-text-primary">{t.name}</span>
                      <span className="text-text-secondary">
                        {money(t.priceMinor)} · sold {t.inventory?.quantitySold ?? 0}/
                        {t.quantityTotal}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-muted">No ticket types yet.</p>
              )}
            </Card>
          ))
        )}
      </div>

      <Card title="Add ticket type">
        <div className="space-y-3">
          <Select
            id="sess"
            label="Session"
            value={form.eventSessionId}
            onChange={(e) => setForm({ ...form, eventSessionId: e.target.value })}
          >
            <option value="">Select session…</option>
            {event.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {dateTime(s.startsAt)}
              </option>
            ))}
          </Select>
          <Input
            id="n"
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            id="p"
            label="Price (₹)"
            type="number"
            value={form.priceRupees}
            onChange={(e) => setForm({ ...form, priceRupees: e.target.value })}
          />
          <Input
            id="q"
            label="Quantity"
            type="number"
            value={form.quantityTotal}
            onChange={(e) => setForm({ ...form, quantityTotal: e.target.value })}
          />
          <Input
            id="m"
            label="Max per order"
            type="number"
            value={form.maxPerOrder}
            onChange={(e) => setForm({ ...form, maxPerOrder: e.target.value })}
          />
          <Button
            className="w-full"
            loading={add.isPending}
            disabled={!valid}
            onClick={() => add.mutate()}
          >
            Add ticket type
          </Button>
        </div>
      </Card>
    </div>
  );
}
