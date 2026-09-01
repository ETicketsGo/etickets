'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Dialog,
  Input,
  Select,
  EmptyState,
  Skeleton,
  StatusBadge,
  ErrorState,
  useToast,
  errorMessage,
  money,
  currencySymbol,
  currencyForCountry,
  dateTime,
  type TicketType,
} from '@eticketsgo/web-kit';

export default function TicketsTab() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<TicketType | null>(null);
  const [editForm, setEditForm] = useState({
    name: '',
    priceRupees: '',
    quantityTotal: '',
    maxPerOrder: '',
  });
  const [deleting, setDeleting] = useState<TicketType | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['event', id] });
  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });

  /*
    The currency this event actually sells in, from where it is.

    The two price fields below were labelled "Price (₹)" and the list formatted every
    amount with `money()`, which falls back to rupees. That was harmless while the server
    also assumed INR everywhere; now that a ticket type is created in the venue's currency,
    a hardcoded ₹ would be an outright lie — an organizer in Idaho typing 499 into a field
    marked ₹ and getting $499.

    Derived with the same helper the API uses, so the label and the stored value cannot
    disagree.
  */
  const currency = currencyForCountry(event?.venue?.country) ?? 'INR';
  const symbol = currencySymbol(currency);

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
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const saveEdit = useMutation({
    mutationFn: () =>
      api.events.updateTicketType(editing!.id, {
        name: editForm.name.trim() || undefined,
        priceMinor:
          editForm.priceRupees === '' ? undefined : Math.round(Number(editForm.priceRupees) * 100),
        quantityTotal: editForm.quantityTotal === '' ? undefined : Number(editForm.quantityTotal),
        maxPerOrder: editForm.maxPerOrder === '' ? undefined : Number(editForm.maxPerOrder),
      }),
    onSuccess: () => {
      toast.push('Ticket type updated.', 'success');
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const toggleActive = useMutation({
    mutationFn: (t: TicketType) =>
      api.events.updateTicketType(t.id, { status: t.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
    onSuccess: () => {
      toast.push('Status updated.', 'success');
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const del = useMutation({
    mutationFn: (t: TicketType) => api.events.deleteTicketType(t.id),
    onSuccess: () => {
      toast.push('Ticket type deleted.', 'success');
      setDeleting(null);
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const openEdit = (t: TicketType) => {
    setEditing(t);
    setEditForm({
      name: t.name,
      priceRupees: String(t.priceMinor / 100),
      quantityTotal: String(t.quantityTotal),
      maxPerOrder: String(t.maxPerOrder),
    });
  };
  const committed = (t: TicketType) =>
    (t.inventory?.quantitySold ?? 0) + (t.inventory?.quantityHeld ?? 0);
  const editValid =
    editForm.name.trim() !== '' &&
    editForm.priceRupees !== '' &&
    Number(editForm.priceRupees) >= 0 &&
    editForm.quantityTotal !== '' &&
    Number(editForm.quantityTotal) >= 1;

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !event) return <Skeleton className="h-64 w-full" />;

  const valid =
    form.eventSessionId &&
    form.name &&
    Number(form.quantityTotal) > 0 &&
    form.priceRupees !== '' &&
    Number(form.priceRupees) >= 0;

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
                    <li
                      key={t.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-medium text-text-primary">{t.name}</span>
                        {t.status !== 'ACTIVE' && <StatusBadge status={t.status} />}
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="text-text-secondary">
                          {/* The ticket's OWN currency, not the event's: an older ticket
                              type may predate a venue change and is still priced in what it
                              was sold in. */}
                          {money(t.priceMinor, t.currency ?? currency)} · sold{' '}
                          {t.inventory?.quantitySold ?? 0} · held {t.inventory?.quantityHeld ?? 0} /{' '}
                          {t.quantityTotal}
                        </span>
                        <span className="flex gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => openEdit(t)}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            loading={toggleActive.isPending}
                            onClick={() => toggleActive.mutate(t)}
                          >
                            {t.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={committed(t) > 0}
                            title={
                              committed(t) > 0 ? 'Has sales/holds — deactivate instead.' : undefined
                            }
                            onClick={() => setDeleting(t)}
                          >
                            Delete
                          </Button>
                        </span>
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
            label={`Price (${symbol})`}
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

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title="Edit ticket type">
        <div className="space-y-3">
          <Input
            id="en"
            label="Name"
            value={editForm.name}
            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
          />
          <Input
            id="ep"
            label={`Price (${symbol})`}
            type="number"
            value={editForm.priceRupees}
            disabled={(editing?.inventory?.quantitySold ?? 0) > 0}
            onChange={(e) => setEditForm({ ...editForm, priceRupees: e.target.value })}
          />
          {(editing?.inventory?.quantitySold ?? 0) > 0 && (
            <p className="text-caption text-text-muted">
              Price is locked because tickets have sold.
            </p>
          )}
          <Input
            id="eq"
            label={`Quantity (min ${editing ? committed(editing) : 0} sold/held)`}
            type="number"
            value={editForm.quantityTotal}
            onChange={(e) => setEditForm({ ...editForm, quantityTotal: e.target.value })}
          />
          <Input
            id="em"
            label="Max per order"
            type="number"
            value={editForm.maxPerOrder}
            onChange={(e) => setEditForm({ ...editForm, maxPerOrder: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              loading={saveEdit.isPending}
              disabled={!editValid}
              onClick={() => saveEdit.mutate()}
            >
              Save
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete ticket type?"
      >
        <div className="space-y-4">
          <p className="text-[0.9375rem] text-text-secondary">
            Delete <span className="font-medium">{deleting?.name}</span>? This can’t be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={del.isPending} onClick={() => del.mutate(deleting!)}>
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
