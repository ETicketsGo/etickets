'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  DataTable,
  Dialog,
  Input,
  PageHeader,
  useToast,
  errorMessage,
  type Column,
  type Venue,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

/**
 * Venues: where your events happen.
 *
 * ── WHY THIS PAGE DID NOT EXIST ────────────────────────────────────────────────────
 * A venue could only be created from the onboarding screen or halfway through the event
 * wizard, and never edited afterwards — yet its name and city print on every listing a
 * customer sees. A typo in a venue name was permanent, and an organizer who moved premises
 * had no way to say so.
 *
 * It is also the organizer's most durable object: events come and go, the hall stays.
 * Something you own for years should not live inside a form you pass through once.
 */
const EMPTY = { name: '', city: '', country: 'India', address: '', capacity: '' };

export default function VenuesPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['venues', activeOrg.id],
    queryFn: () => api.venues.list(activeOrg.id),
  });

  const [editing, setEditing] = useState<Venue | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const openCreate = () => {
    setForm(EMPTY);
    setCreating(true);
  };
  const openEdit = (v: Venue) => {
    setForm({
      name: v.name,
      city: v.city,
      country: v.country,
      address: v.address ?? '',
      capacity: v.capacity != null ? String(v.capacity) : '',
    });
    setEditing(v);
  };
  const close = () => {
    setCreating(false);
    setEditing(null);
  };

  /*
    Blank optional fields are sent as undefined, not ''. An empty address box means "I did
    not fill this in", and writing an empty string over an address somebody entered earlier
    would silently destroy it.
  */
  const payload = () => ({
    name: form.name.trim(),
    city: form.city.trim(),
    country: form.country.trim() || 'India',
    address: form.address.trim() || undefined,
    capacity: form.capacity ? Number(form.capacity) : undefined,
  });

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api.venues.update(editing.id, payload())
        : api.venues.create({ organizationId: activeOrg.id, ...payload() }),
    onSuccess: () => {
      toast.push(editing ? 'Venue updated.' : 'Venue added.', 'success');
      close();
      qc.invalidateQueries({ queryKey: ['venues', activeOrg.id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<Venue>[] = [
    {
      key: 'name',
      header: 'Venue',
      sortable: true,
      sortValue: (v) => v.name.toLowerCase(),
      render: (v) => (
        <div>
          <p className="font-medium text-text-primary">{v.name}</p>
          {v.address && <p className="text-caption text-text-muted">{v.address}</p>}
        </div>
      ),
    },
    {
      key: 'city',
      header: 'City',
      sortable: true,
      sortValue: (v) => v.city,
      render: (v) => v.city,
    },
    {
      key: 'capacity',
      header: 'Capacity',
      // An em dash rather than 0: not knowing a capacity is not the same as seating nobody.
      render: (v) => (v.capacity != null ? v.capacity.toLocaleString() : '—'),
    },
    {
      key: 'edit',
      header: '',
      render: (v) => (
        <button
          type="button"
          onClick={() => openEdit(v)}
          className="rounded text-caption text-action-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Edit
        </button>
      ),
    },
  ];

  const valid = form.name.trim().length > 0 && form.city.trim().length > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Venues"
        description="The places your events happen. Their name and city appear on every listing."
        action={<Button onClick={openCreate}>New venue</Button>}
      />

      <DataTable
        columns={columns}
        rows={data}
        loading={isLoading}
        rowKey={(v) => v.id}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={
          <div className="p-8 text-center text-text-muted">
            No venues yet. Add the hall, theatre or ground where your events take place — you pick
            one for every event you create.
          </div>
        }
      />

      {/*
        Rooms and seat maps live in their own section, and that is worth signposting: a
        venue here and a room with a seating plan are different objects, and somebody
        looking for one in the other is the confusion this product has already had once.
      */}
      <Card>
        <p className="text-[0.9375rem] text-text-secondary">
          Selling numbered seats? A seating plan belongs to a <strong>room</strong>, not a venue —
          set those up under <strong>Rooms &amp; seat maps</strong>.
        </p>
      </Card>

      <Dialog
        open={creating || !!editing}
        onClose={close}
        title={editing ? 'Edit venue' : 'New venue'}
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
              {editing ? 'Save changes' : 'Add venue'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input
            id="venueName"
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              id="venueCity"
              label="City"
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
            <Input
              id="venueCountry"
              label="Country"
              value={form.country}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
            />
          </div>
          <Input
            id="venueAddress"
            label="Address (optional)"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
          <Input
            id="venueCapacity"
            label="Capacity (optional)"
            type="number"
            hint="Roughly how many people fit. Used for reporting, not for limiting sales."
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
          />
        </div>
      </Dialog>
    </div>
  );
}
