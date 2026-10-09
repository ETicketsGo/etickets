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
  useToast,
  errorMessage,
  LocationFields,
  defaultLocation,
  type CinemaBody,
  type LocationValue,
} from '@eticketsgo/web-kit';
import { venueZone } from '@eticketsgo/shared-types';
import { VenuePicker, InheritedVenueLocation } from '@/components/venue-fields';
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

  // Prefilled when arriving from a venue on the venues page, so "Add a space here" means here.
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

  const selectedVenue = (venues.data ?? []).find((v) => v.id === venueId) ?? null;
  /*
    Where a NEW venue is. This form created venues from a city and a street alone - no country,
    state or time zone - so a space added here had no currency, no tax rules and a clock that
    defaulted to India wherever it really was. The venues page and the event wizard already ask
    these three; this is the same component.
  */
  const [where, setWhere] = useState<LocationValue>(defaultLocation);

  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (form.name.trim().length < 2) e.name = 'Name must be at least 2 characters.';
    /*
      Only asked when there is no venue to inherit from. With a venue selected the city is
      the venue's, and demanding it again is how the two came to disagree.
    */
    if (!selectedVenue && !form.city.trim()) e.city = 'Which city is it in?';
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
        // Inherited, not retyped: a space is where its venue is.
        city: (selectedVenue?.city ?? form.city).trim(),
        address: (selectedVenue?.address ?? form.address)?.trim() || undefined,
        latitude: form.latitude ? Number(form.latitude) : undefined,
        longitude: form.longitude ? Number(form.longitude) : undefined,
        // Empty means "make a new one", which is what the server already does with no value.
        venueId: venueId || undefined,
        /*
          The space's clock is its venue's: the zone the venue was given, else its country's
          only zone. Without this every space defaulted to the launch market's zone.
        */
        ...(selectedVenue
          ? {
              timezone: venueZone(selectedVenue.timezone, selectedVenue.country) ?? undefined,
            }
          : {
              country: where.country,
              region: where.region || undefined,
              timezone: where.timezone || undefined,
            }),
      };
      return api.cinemas.create({ organizationId: activeOrg.id, ...body });
    },
    onSuccess: (cinema) => {
      toast.push('Space created.', 'success');
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
        title="New space"
        breadcrumbs={[
          { label: 'Venues & spaces', href: '/organizer/venues' },
          { label: 'New space' },
        ]}
      />
      <Card>
        <div className="space-y-4">
          {/*
            THE VENUE COMES FIRST, AND IT DECIDES WHERE THIS IS.

            This form used to ask for City, Street address, Latitude and Longitude and THEN
            ask "Which venue is this room in?". An organizer typed a location, then named the
            venue that already had one, and nothing reconciled the two - which is exactly why
            a space inside a venue could appear to be somewhere else. It genuinely could.

            A space is a physical area INSIDE a venue, so it is where the venue is. Choosing
            an existing venue now shows that location instead of asking for it again.
          */}
          <VenuePicker
            venues={venues.data ?? []}
            value={venueId}
            onChange={setVenueId}
            label="Which venue is this space in?"
          />

          <Input
            id="name"
            label="Space name"
            hint="What people call it inside the venue, for example Screen 4, Main Hall, Auditorium."
            autoFocus
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            error={fieldErrors.name}
          />
          <Input
            id="brand"
            label="Brand (optional)"
            value={form.brand}
            onChange={(e) => set('brand', e.target.value)}
          />

          {selectedVenue ? (
            <InheritedVenueLocation venue={selectedVenue} />
          ) : (
            <>
              <p className="text-[0.9375rem] text-text-secondary">
                This creates a new venue for the space. Tell us where it is.
              </p>
              <Input
                id="city"
                label="City"
                value={form.city}
                onChange={(e) => set('city', e.target.value)}
                error={fieldErrors.city}
              />
              <Input
                id="address"
                label="Street address"
                hint="Just the street and area. The city is set above."
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
              />
              <LocationFields
                idPrefix="space-venue"
                value={where}
                onChange={setWhere}
                countryHint="Sets the currency you sell in and the tax rules that apply."
              />
            </>
          )}

          {/*
            Coordinates pin a VENUE on a map. They were two required-looking boxes in the
            middle of the form that most organizers cannot answer, so they are folded away.
          */}
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-[0.9375rem] font-medium text-text-primary">
              Add map coordinates (optional)
            </summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
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
          </details>

          <Button loading={create.isPending} onClick={submit}>
            Create space
          </Button>
        </div>
      </Card>
    </div>
  );
}
