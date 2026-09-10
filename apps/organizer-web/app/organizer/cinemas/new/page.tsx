'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  PageHeader,
  Select,
  useToast,
  errorMessage,
  type CinemaBody,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

/**
 * A room, and the venue it sits in.
 *
 * ── WHY THE VENUE IS ASKED FOR HERE ────────────────────────────────────────────────
 * It was not, and the API makes one when none is given — named after the room. So adding
 * "Room-1" also produced a venue called "Room-1", and the organizer then saw the same name
 * in two lists as two unrelated things. Nothing failed; nothing explained itself either.
 *
 * The default is still "create a new venue", because that is genuinely right for a first
 * room at a new site and because changing what an unattended form does would be worse than
 * the duplication. What changed is that there is now a choice, and it is visible.
 */
export default function NewCinemaPage() {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const toast = useToast();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const venues = useQuery({
    queryKey: ['venues', activeOrg.id],
    queryFn: () => api.venues.list(activeOrg.id),
  });

  // Prefilled when arriving from a venue on the venues page, so "Add a room here" means here.
  const params = useSearchParams();
  const [venueId, setVenueId] = useState(params.get('venueId') ?? '');

  const [form, setForm] = useState({
    name: '',
    brand: '',
    city: '',
    address: '',
    latitude: '',
    longitude: '',
  });

  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (form.name.trim().length < 2) e.name = 'Name must be at least 2 characters.';
    if (!form.city.trim()) e.city = 'City is required.';
    if (form.latitude && !Number.isFinite(Number(form.latitude)))
      e.latitude = 'Latitude must be a number.';
    if (form.longitude && !Number.isFinite(Number(form.longitude)))
      e.longitude = 'Longitude must be a number.';
    return e;
  };

  const create = useMutation({
    mutationFn: () => {
      const body: CinemaBody = {
        name: form.name.trim(),
        brand: form.brand.trim() || undefined,
        city: form.city.trim(),
        address: form.address.trim() || undefined,
        latitude: form.latitude ? Number(form.latitude) : undefined,
        longitude: form.longitude ? Number(form.longitude) : undefined,
        // Empty means "make a new one", which is what the server already does with no value.
        venueId: venueId || undefined,
      };
      return api.cinemas.create({ organizationId: activeOrg.id, ...body });
    },
    onSuccess: (cinema) => {
      toast.push('Room created.', 'success');
      router.push(`/organizer/cinemas/${cinema.id}`);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const submit = () => {
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    create.mutate();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="New room"
        breadcrumbs={[
          { label: 'Venues & rooms', href: '/organizer/venues' },
          { label: 'New room' },
        ]}
      />
      <Card>
        <div className="space-y-4">
          <Input
            id="name"
            label="Name"
            autoFocus
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            error={fieldErrors.name}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="brand"
              label="Brand"
              value={form.brand}
              onChange={(e) => set('brand', e.target.value)}
            />
            <Input
              id="city"
              label="City"
              value={form.city}
              onChange={(e) => set('city', e.target.value)}
              error={fieldErrors.city}
            />
          </div>
          <Input
            id="address"
            label="Address"
            value={form.address}
            onChange={(e) => set('address', e.target.value)}
          />
          <Select
            id="venueId"
            label="Which venue is this room in?"
            hint="Leave as a new venue if this is a new site. Choosing an existing one keeps the address and city on your public listings consistent."
            value={venueId}
            onChange={(e) => setVenueId(e.target.value)}
          >
            <option value="">Create a new venue for it</option>
            {(venues.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} — {v.city}
              </option>
            ))}
          </Select>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="latitude"
              label="Latitude"
              value={form.latitude}
              onChange={(e) => set('latitude', e.target.value)}
              error={fieldErrors.latitude}
            />
            <Input
              id="longitude"
              label="Longitude"
              value={form.longitude}
              onChange={(e) => set('longitude', e.target.value)}
              error={fieldErrors.longitude}
            />
          </div>
          <Button loading={create.isPending} onClick={submit}>
            Create room
          </Button>
        </div>
      </Card>
    </div>
  );
}
