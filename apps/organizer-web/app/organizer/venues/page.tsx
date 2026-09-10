'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  api,
  Button,
  ButtonLink,
  Card,
  Dialog,
  Input,
  LocationFields,
  PageHeader,
  Skeleton,
  defaultLocation,
  locationFrom,
  useToast,
  errorMessage,
  type Cinema,
  type LocationValue,
  type Venue,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { groupRoomsByVenue, screenCount } from './venue-rooms';

/**
 * Venues and the rooms inside them, on one screen.
 *
 * ── WHY THESE WERE EVER TWO SCREENS ────────────────────────────────────────────────
 * A venue is where an event happens. A room is the thing that owns a seat map. They are
 * genuinely different objects, so they were given a section each — and the previous version
 * of this page ended with a card explaining, in prose, that seating plans live in the OTHER
 * section. A product that has to explain its own navigation has already lost the argument.
 *
 * ── AND WHY THE SPLIT WAS WORSE THAN IT LOOKED ─────────────────────────────────────
 * Creating a room does not require a venue: when none is given the API makes one, named
 * after the room. So an organizer who added "Room-1" got a venue called "Room-1" as well,
 * and then saw the same name in two different lists as two unrelated things. Nothing was
 * broken and nothing said what had happened.
 *
 * Nesting the rooms under their venue makes that visible in the only way that really works —
 * by showing it. The room form now offers the venue too, so the next one does not multiply.
 */
const EMPTY = { name: '', city: '', address: '', capacity: '' };

/** One room under its venue: what it is, how much of it is ready, and where to go next. */
function RoomRow({ room }: { room: Cinema }) {
  const screens = screenCount(room);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-3 py-2">
      <div className="min-w-0">
        <Link
          href={`/organizer/cinemas/${room.id}`}
          className="rounded font-medium text-text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
        >
          {room.name}
        </Link>
        {room.brand && <p className="text-caption text-text-muted">{room.brand}</p>}
      </div>
      {/*
        The count, because a room with no screens has no seat map and cannot sell a numbered
        seat — and that is invisible from the name alone.
      */}
      <span className="text-caption text-text-secondary">
        {screens === 0 ? 'No screens yet' : `${screens} screen${screens === 1 ? '' : 's'}`}
      </span>
    </li>
  );
}

export default function VenuesPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const venues = useQuery({
    queryKey: ['venues', activeOrg.id],
    queryFn: () => api.venues.list(activeOrg.id),
  });
  const rooms = useQuery({
    queryKey: ['cinemas', activeOrg.id],
    queryFn: () => api.cinemas.list(activeOrg.id),
  });

  // The rule, and the reasons for it, live in `venue-rooms.ts` where a test can reach them.
  const grouped = useMemo(
    () => groupRoomsByVenue(venues.data ?? [], rooms.data ?? []),
    [venues.data, rooms.data],
  );

  const [editing, setEditing] = useState<Venue | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  /*
    Where the venue is, kept apart from the rest of the form because the three fields depend
    on each other: the country decides which subdivisions exist and which clocks are plausible.
  */
  const [where, setWhere] = useState<LocationValue>({ country: 'India', region: '', timezone: '' });

  const openCreate = () => {
    setForm(EMPTY);
    // Opens on a guess from the browser's locale, and says so. One click to correct.
    setWhere(defaultLocation());
    setCreating(true);
  };
  const openEdit = (v: Venue) => {
    setForm({
      name: v.name,
      city: v.city,
      address: v.address ?? '',
      capacity: v.capacity != null ? String(v.capacity) : '',
    });
    setWhere(locationFrom(v));
    setEditing(v);
  };
  const close = () => {
    setCreating(false);
    setEditing(null);
  };

  /*
    Arriving from "Add venue" on the setup checklist opens the form.

    That link used to point at the onboarding page itself — the page the organizer was
    already on — so the button did nothing at all. Landing on a list and having to find the
    button again would be an improvement and still not what was asked for; this lands on the
    open form.
  */
  const params = useSearchParams();
  const wantsNew = params.get('new') === '1';
  useEffect(() => {
    if (wantsNew) openCreate();
    // Runs for the query parameter, not on every render: reopening the dialog after somebody
    // closed it would make it impossible to dismiss.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsNew]);

  /*
    Blank optional fields are sent as undefined, not ''. An empty address box means "I did
    not fill this in", and writing an empty string over an address somebody entered earlier
    would silently destroy it.
  */
  const payload = () => ({
    name: form.name.trim(),
    city: form.city.trim(),
    country: where.country.trim() || 'India',
    /*
      Sent as '' rather than undefined when cleared, so an organizer CAN unset a state they
      picked by mistake. The address rule above is the opposite — there, blank means "not
      filled in" — and the difference is that this field is a dropdown with an explicit
      "Not specified" choice, which is somebody saying so rather than not answering.
    */
    region: where.region.trim(),
    timezone: where.timezone || undefined,
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

  const valid = form.name.trim().length > 0 && form.city.trim().length > 0;
  const loading = venues.isLoading || rooms.isLoading;
  const failed = venues.isError || rooms.isError;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Venues & rooms"
        description="Where your events happen, and the rooms inside them. A seating plan belongs to a room."
        action={
          <div className="flex gap-2">
            <ButtonLink href="/organizer/cinemas/new" variant="outline">
              New room
            </ButtonLink>
            <Button onClick={openCreate}>New venue</Button>
          </div>
        }
      />

      {loading && <Skeleton className="h-40 w-full" />}

      {failed && !loading && (
        <Card>
          <p className="text-sm text-text-secondary">We couldn’t load this. Please try again.</p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => {
              venues.refetch();
              rooms.refetch();
            }}
          >
            Retry
          </Button>
        </Card>
      )}

      {!loading && !failed && grouped.venues.length === 0 && grouped.orphans.length === 0 && (
        <Card>
          <p className="text-sm text-text-secondary">
            No venues yet. Add the hall, theatre or ground where your events take place — you pick
            one for every event you create. If you sell numbered seats, add a room inside it and
            draw the seating plan there.
          </p>
        </Card>
      )}

      {!loading &&
        !failed &&
        grouped.venues.map(({ venue, rooms: inside }) => {
          return (
            <Card key={venue.id}>
              {/*
                A stable hook for the end-to-end tests. They used to address table cells
                and rows; this page has neither any more, and pinning them to the div
                nesting instead would break on the next styling change.
              */}
              <div
                data-testid="venue-card"
                className="flex flex-wrap items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <h3 className="font-medium text-text-primary">{venue.name}</h3>
                  <p className="text-caption text-text-secondary">
                    {[venue.city, venue.region, venue.country].filter(Boolean).join(', ')}
                    {venue.capacity != null && ` · seats about ${venue.capacity.toLocaleString()}`}
                  </p>
                  {venue.address && <p className="text-caption text-text-muted">{venue.address}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => openEdit(venue)}
                  className="rounded text-caption text-action-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  Edit venue
                </button>
              </div>

              <div className="mt-4">
                {inside.length > 0 ? (
                  <ul className="space-y-2">
                    {inside.map((room) => (
                      <RoomRow key={room.id} room={room} />
                    ))}
                  </ul>
                ) : (
                  /*
                    Said here rather than left blank. "No rooms" is not a fault — a lawn or a
                    stadium terrace sells fine without one — so this states the consequence
                    and lets the organizer decide, instead of reading as something undone.
                  */
                  <p className="text-caption text-text-secondary">
                    No rooms here. Add one if you want buyers to pick their own seat.
                  </p>
                )}
                {/*
                  Carries the venue, so the room joins this one instead of quietly creating a
                  second venue with the same name.
                */}
                <Link
                  href={`/organizer/cinemas/new?venueId=${venue.id}`}
                  className="mt-3 inline-block rounded text-caption text-brand-primary underline underline-offset-2 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
                >
                  Add a room here
                </Link>
              </div>
            </Card>
          );
        })}

      {!loading && !failed && grouped.orphans.length > 0 && (
        <Card title="Rooms not linked to a venue">
          <p className="mb-3 text-caption text-text-secondary">
            These work, and their events still sell. Linking them to a venue keeps the public
            listing’s address and city right.
          </p>
          <ul className="space-y-2">
            {grouped.orphans.map((room) => (
              <RoomRow key={room.id} room={room} />
            ))}
          </ul>
        </Card>
      )}

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
          <Input
            id="venueCity"
            label="City"
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
          />
          <LocationFields
            idPrefix="venue"
            value={where}
            onChange={setWhere}
            countryHint="Sets the currency you sell in and the tax rules that apply."
          />
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
