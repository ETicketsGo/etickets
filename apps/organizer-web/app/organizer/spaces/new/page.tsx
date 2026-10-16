'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Armchair, Film, Footprints, Landmark } from 'lucide-react';
import {
  api,
  Button,
  Card,
  Input,
  PageHeader,
  Select,
  Skeleton,
  errorMessage,
  useToast,
} from '@eticketsgo/web-kit';
import { SPACE_KINDS, SPACE_KIND_VALUES, type SpaceKind } from '@eticketsgo/shared-types';
import {
  InheritedVenueLocation,
  VenueFields,
  VenuePicker,
  emptyVenueDraft,
  homeLocation,
  venuePayload,
  venueProblems,
  type VenueDraft,
} from '@/components/venue-fields';
import { useOrg } from '@/components/org-context';

/**
 * Add a space to a venue: which venue, what the space is called, and what kind of place it is.
 *
 * -- WHY THIS REPLACED "NEW SPACE" ON THE CINEMA FORM -----------------------------------------
 * "New space" was the new-CINEMA page with new labels. It created a Cinema named after the
 * space and landed on that cinema's page, which asked for a brand, a street address and a map
 * pin and then showed an empty "Screens" list with "Add screen" - so "Screen 2" contained
 * screens. The organizer had asked for one room and was handed a building to fill.
 *
 * Now the venue is chosen once and its location is shown, never asked again; the kind of
 * space is asked once, here, and decides what the space's page offers next (cinema grids for a
 * screen, arena maps for an arena, no seat map for a standing floor); and Create lands on the
 * space itself. A cinema screen still joins the venue's cinema - the API makes one from the
 * venue the first time - because films are scheduled per cinema, but nobody has to see it to
 * add a screen.
 */

const KIND_ICON: Record<SpaceKind, typeof Film> = {
  CINEMA_SCREEN: Film,
  SEATED_HALL: Landmark,
  ARENA: Armchair,
  STANDING: Footprints,
};

const NAME_HINT: Record<SpaceKind, string> = {
  CINEMA_SCREEN: 'For example Screen 2, Audi 4 or IMAX.',
  SEATED_HALL: 'For example Main Hall, Auditorium or Studio Theatre.',
  ARENA: 'For example Main Arena or Centre Court.',
  STANDING: 'For example Main Floor, Lawn or Terrace.',
};

/** Projection formats a cinema screen is sold as. Only asked for a cinema screen. */
const SCREEN_FORMATS = ['2D', '3D', 'IMAX', '4DX', 'Dolby Atmos', 'Recliner'];

function isKind(value: string | null): value is SpaceKind {
  return !!value && (SPACE_KIND_VALUES as readonly string[]).includes(value);
}

export default function NewSpacePage() {
  const { activeOrg } = useOrg();
  const router = useRouter();
  const toast = useToast();
  const params = useSearchParams();

  const venues = useQuery({
    queryKey: ['venues', activeOrg.id],
    queryFn: () => api.venues.list(activeOrg.id),
  });

  // Arriving from "Add a space here" on a venue means that venue.
  const [venueId, setVenueId] = useState(params.get('venueId') ?? '');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SpaceKind | ''>(() => {
    const k = params.get('kind');
    return isKind(k) ? k : '';
  });
  const [capacity, setCapacity] = useState('');
  const [screenType, setScreenType] = useState('2D');
  const [newVenue, setNewVenue] = useState<VenueDraft>(() => ({
    ...emptyVenueDraft(),
    where: homeLocation(activeOrg.registeredCountry, []),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});

  /*
    A new venue starts in the country this organization already sells in, not the browser's.

    The browser guess put a Warangal venue in the United States on QA, and through it every
    price on that venue in dollars. The organization's registered country, else where most of
    its venues are, is a far better first answer - the same rule as every other door that
    creates a venue (`homeLocation`), and still only a first answer, shown and changeable.
  */
  useEffect(() => {
    if (!venues.data) return;
    const home = homeLocation(activeOrg.registeredCountry, venues.data);
    setNewVenue((v) => (v.name || v.city ? v : { ...v, where: home }));
  }, [venues.data, activeOrg.registeredCountry]);

  const list = venues.data ?? [];
  const selectedVenue = list.find((v) => v.id === venueId) ?? null;
  const makingVenue = !selectedVenue;
  const standing = kind === 'STANDING';

  const validate = () => {
    const e: Record<string, string> = {};
    if (makingVenue) {
      for (const [k, v] of Object.entries(venueProblems(newVenue))) e[`venue-${k}`] = v;
    }
    if (name.trim().length < 1) e.name = 'Give the space a name.';
    if (!kind) e.kind = 'Choose what kind of space it is.';
    const n = Number(capacity);
    if (!capacity.trim() || !Number.isInteger(n) || n < 1)
      e.capacity = standing
        ? 'How many people can it hold? Enter a whole number.'
        : 'About how many seats? Enter a whole number.';
    return e;
  };

  const create = useMutation({
    mutationFn: async () => {
      const targetVenueId = makingVenue
        ? (await api.venues.create({ organizationId: activeOrg.id, ...venuePayload(newVenue) })).id
        : venueId;
      return api.venues.addSpace(targetVenueId, {
        name: name.trim(),
        kind: kind as SpaceKind,
        capacity: Number(capacity),
        ...(kind === 'CINEMA_SCREEN' ? { screenType } : {}),
      });
    },
    onSuccess: (space) => {
      toast.push('Space added.', 'success');
      router.push(`/organizer/spaces/${space.id}`);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const submit = () => {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length === 0) create.mutate();
  };

  const venueErrors = Object.fromEntries(
    Object.entries(errors)
      .filter(([k]) => k.startsWith('venue-'))
      .map(([k, v]) => [k.slice('venue-'.length), v]),
  );

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="New space"
        description="Part of a venue where people watch: a cinema screen, a hall, an arena or an open floor."
        breadcrumbs={[
          { label: 'Venues & seating', href: '/organizer/venues' },
          { label: 'New space' },
        ]}
      />
      <Card>
        {venues.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-6">
            <section className="space-y-3">
              {list.length > 0 ? (
                <VenuePicker
                  venues={list}
                  value={venueId}
                  onChange={setVenueId}
                  label="Which venue is it in?"
                />
              ) : null}
              {selectedVenue ? (
                <InheritedVenueLocation venue={selectedVenue} />
              ) : (
                <div className="space-y-3">
                  <p className="text-[0.9375rem] text-text-secondary">
                    {list.length > 0
                      ? 'A new venue is created for this space. Tell us where it is, once.'
                      : 'You have no venues yet. Tell us where this one is, once.'}
                  </p>
                  <VenueFields draft={newVenue} onChange={setNewVenue} errors={venueErrors} />
                </div>
              )}
            </section>

            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium text-text-primary">
                What kind of space is it?
              </legend>
              <p className="-mt-1 mb-2 text-caption text-text-muted">
                Asked once. It decides which seat layouts we offer for it.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {SPACE_KINDS.map((k) => {
                  const Icon = KIND_ICON[k.kind];
                  const on = kind === k.kind;
                  return (
                    <label
                      key={k.kind}
                      data-testid={`kind-${k.kind}`}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring/50 ${
                        on
                          ? 'border-action-primary bg-tint-primary'
                          : 'border-border hover:bg-background-subtle'
                      }`}
                    >
                      <input
                        type="radio"
                        name="space-kind"
                        value={k.kind}
                        checked={on}
                        onChange={() => {
                          setKind(k.kind);
                          setErrors((e) => ({ ...e, kind: '' }));
                        }}
                        className="sr-only"
                      />
                      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-action-primary" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-text-primary">
                          {k.label}
                        </span>
                        <span
                          className={`block text-caption leading-snug ${on ? 'text-text-primary' : 'text-text-secondary'}`}
                        >
                          {k.sentence}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {errors.kind ? (
                <p role="alert" className="text-caption text-status-error">
                  {errors.kind}
                </p>
              ) : null}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                id="space-name"
                label="Space name"
                hint={kind ? NAME_HINT[kind] : 'What people call it inside the venue.'}
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={errors.name || undefined}
              />
              <Input
                id="space-capacity"
                label={standing ? 'How many people can it hold?' : 'About how many seats?'}
                hint={
                  standing
                    ? 'The most you will ever sell for one session here.'
                    : 'A rough number. The seat layout you add next sets the exact count.'
                }
                type="number"
                min={1}
                inputMode="numeric"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                error={errors.capacity || undefined}
              />
              {kind === 'CINEMA_SCREEN' ? (
                <Select
                  id="space-format"
                  label="Screen format"
                  value={screenType}
                  onChange={(e) => setScreenType(e.target.value)}
                >
                  {SCREEN_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>

            <Button loading={create.isPending} onClick={submit}>
              Create space
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
