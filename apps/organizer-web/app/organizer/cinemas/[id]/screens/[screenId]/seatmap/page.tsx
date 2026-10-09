'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Accessibility, Eye, Trash2 } from 'lucide-react';
import {
  api,
  Button,
  Card,
  Input,
  Skeleton,
  ErrorState,
  PageHeader,
  useToast,
  errorMessage,
  money,
  type GenerateSeatMapBody,
  currencyForCountry,
  ButtonLink,
  type LayoutTemplateOutline,
} from '@eticketsgo/web-kit';
import { countSeatKinds, reconcileSeats, type LayoutGalleryOption } from '@eticketsgo/shared-types';
import {
  capacitySummary,
  expandRowLabels,
  nextGapSeats,
  previewSection,
  seatKindsFor,
  type SeatKind,
  type SectionDraft,
} from '@/lib/seat-layout';
import { RoomShapePicker } from '@/components/room-shape-picker';
import { ROOM_SHAPES, planRoom } from '@/lib/room-plan';
import { draftsFromOutline } from '@/lib/layout-gallery';
import { LayoutTemplateGallery } from '@/components/layout-template-gallery';
import { SeatCountSummary } from '@/components/seat-count-summary';
import { SeatingExplainer } from '@/components/seating-explainer';

/**
 * A section starts as a STANDARD SCREEN of its typical size, already planned.
 *
 * Not blank. An empty form asking for row labels is the thing organizers reported twice as
 * too hard; opening on a real, editable room means the common case is "adjust the number"
 * rather than "work out the arithmetic".
 */
const DEFAULT_SHAPE = ROOM_SHAPES[1];
const DEFAULT_PLAN = planRoom(DEFAULT_SHAPE.typicalSeats, DEFAULT_SHAPE);
const DEFAULT_AISLE = DEFAULT_PLAN.aisle === null ? '' : String(DEFAULT_PLAN.aisle);

const emptySection: SectionDraft = {
  name: '',
  categoryName: '',
  colorHex: '#2563EB',
  basePrice: '',
  rowLabels: DEFAULT_PLAN.rowLabels.join(', '),
  seatsPerRow: String(DEFAULT_PLAN.seatsPerRow),
  wheelchairSeats: '',
  companionSeats: '',
  // The planned aisle, as the planner suggested it. Left blank, the opening room counted its
  // aisle column as seats: "153 seats to sell" above "162 bookable" below, before any edit.
  gapSeats: DEFAULT_AISLE,
};

/** Colour per seat kind in the preview. Kind is also written out, never colour alone. */
const KIND_STYLE: Record<SeatKind, string> = {
  SEAT: 'bg-background-subtle text-text-muted border-border',
  WHEELCHAIR: 'bg-tint-primary text-action-primary border-action-primary/40 font-semibold',
  COMPANION: 'bg-action-primary/5 text-action-primary/80 border-action-primary/25',
  GAP: 'bg-transparent text-transparent border-transparent',
};

export default function ScreenSeatMapPage() {
  const { id, screenId } = useParams<{ id: string; screenId: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();

  const seatMapQ = useQuery({
    queryKey: ['seatmap', screenId],
    queryFn: () => api.shows.getSeatMap(screenId),
  });
  const screensQ = useQuery({
    queryKey: ['cinema', id, 'screens'],
    queryFn: () => api.cinemas.screens(id),
  });
  const screen = screensQ.data?.find((s) => s.id === screenId);

  /*
    The currency this room prices in, which is its VENUE's.

    The base-price box said "Base price (₹)" for every room in the world. Nothing converted
    the number — only the label was wrong — which is the version of that bug an organizer
    cannot notice, because everything downstream stays consistent with whatever they typed.
  */
  const cinemaQ = useQuery({
    queryKey: ['cinema', id],
    queryFn: () => api.cinemas.get(id),
  });
  const roomCurrency = currencyForCountry(cinemaQ.data?.venue?.country) ?? 'INR';
  const currencySymbol =
    new Intl.NumberFormat(undefined, { style: 'currency', currency: roomCurrency })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value ?? roomCurrency;

  const [name, setName] = useState('');
  const [sections, setSections] = useState<SectionDraft[]>([{ ...emptySection }]);
  /*
    The shape and capacity a section was planned FROM, kept alongside the draft.

    Not derived back out of rowLabels: two different shapes can produce the same grid, so
    reading the intent from the result would make the picker jump to a shape the organizer
    never chose. This is what they said; the draft is what it produced.
  */
  const [plans, setPlans] = useState<
    { shapeKey: string; capacity: string; suggestedAisle: string }[]
  >([
    {
      shapeKey: DEFAULT_SHAPE.key,
      capacity: String(DEFAULT_SHAPE.typicalSeats),
      suggestedAisle: DEFAULT_AISLE,
    },
  ]);
  /**
   * The bookable count the organizer has confirmed, when it differs from what they asked for.
   * Cleared whenever the count changes, so a confirmation never outlives the room it was for.
   */
  const [confirmedBookable, setConfirmedBookable] = useState<number | null>(null);
  /** Which sections have the exact row/seat fields open. Closed by default. */
  const [exact, setExact] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<string | null>(null);
  /** The gallery card chosen, and for a block venue the price it will be built with. */
  const [chosen, setChosen] = useState<{
    option: LayoutGalleryOption;
    outline: LayoutTemplateOutline | null;
  } | null>(null);
  const [venueBasePrice, setVenueBasePrice] = useState('');

  /**
   * A gallery card was chosen.
   *
   * A grid template FILLS the generator below - rows, aisle, wheelchair bay, categories - so
   * every number is still in front of the organizer before anything is written. A block venue
   * cannot be described by this form at all, so it is built as a draft by the template
   * builder and opened in the buyer preview. General admission needs no seat map.
   */
  const chooseTemplate = (option: LayoutGalleryOption, outline: LayoutTemplateOutline | null) => {
    setChosen({ option, outline });
    setErrors(null);
    if (option.style !== 'GRID' || !outline) return;
    const drafts = draftsFromOutline(outline, '');
    setName(option.label);
    setSections(drafts);
    setPlans(
      drafts.map((d) => ({
        shapeKey: DEFAULT_SHAPE.key,
        // What this section sells, so the "you asked for" check agrees with the template.
        capacity: String(previewSection(d).sellable),
        suggestedAisle: d.gapSeats,
      })),
    );
    setConfirmedBookable(null);
  };

  const buildVenue = useMutation({
    mutationFn: () => {
      const template = chosen?.option.template;
      if (!template) throw new Error('Choose a template first.');
      return api.theaterOps.createLayoutFromTemplate(screenId, {
        template,
        name: chosen.option.label,
        basePriceMinor: Math.round(Number(venueBasePrice) * 100),
      });
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['seatmap', screenId] });
      qc.invalidateQueries({ queryKey: ['screen', screenId, 'layouts'] });
      toast.push('Draft layout built. Check it as a buyer, then publish it.', 'success');
      router.push(`/organizer/cinemas/${id}/screens/${screenId}/layouts/${created.id}/preview`);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const setSection = (idx: number, patch: Partial<SectionDraft>) => {
    /*
      Clearing the error on edit is the fix for a reported bug, not tidiness.

      `errors` was only ever written on submit and never cleared, so after a failed submit
      the message stayed on screen while the operator corrected the field — producing
      "Section 1: category name is required." sitting directly beneath a Category name box
      containing "A". The screen contradicted itself, and the only way to clear it was to
      submit again and hope.
    */
    setErrors(null);
    setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };
  const addSection = () => {
    setSections((prev) => [...prev, { ...emptySection }]);
    setPlans((prev) => [
      ...prev,
      {
        shapeKey: DEFAULT_SHAPE.key,
        capacity: String(DEFAULT_SHAPE.typicalSeats),
        suggestedAisle: DEFAULT_AISLE,
      },
    ]);
  };
  const removeSection = (idx: number) => {
    setSections((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));
    setPlans((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));
  };

  /**
   * Apply a planned room to a section.
   *
   * The plan writes the row labels and the row width; everything else the organizer typed —
   * name, category, price, colour, accessible seating — is left alone. Re-planning must not
   * discard the rest of their work.
   */
  const applyPlan = (
    idx: number,
    next: { shapeKey: string; capacity: string; plan: ReturnType<typeof planRoom> },
  ) => {
    const previousSuggestion = plans[idx]?.suggestedAisle ?? '';
    const aisle = next.plan.aisle;
    setPlans((prev) =>
      prev.map((p, i) =>
        i === idx
          ? {
              shapeKey: next.shapeKey,
              capacity: next.capacity,
              suggestedAisle: aisle === null ? '' : String(aisle),
            }
          : p,
      ),
    );
    if (!Number.isFinite(Number(next.capacity)) || Number(next.capacity) < 1) return;

    /*
      The suggested aisle follows the plan; an aisle the organizer typed is theirs.

      It used to be written only into an EMPTY box, so a second plan left the first plan's aisle
      behind - or none - and the preview counted the aisle column as seats ("153 seats to sell"
      above, "162 bookable" below). See `nextGapSeats`.
    */
    const current = sections[idx];
    setSection(idx, {
      rowLabels: next.plan.rowLabels.join(', '),
      seatsPerRow: String(next.plan.seatsPerRow),
      gapSeats: nextGapSeats(current?.gapSeats ?? '', previousSuggestion, aisle),
    });
  };

  const generate = useMutation({
    mutationFn: () => {
      const body: GenerateSeatMapBody = {
        name: name.trim() || undefined,
        sections: sections.map((s) => ({
          name: s.name.trim(),
          categoryName: s.categoryName.trim(),
          colorHex: s.colorHex || undefined,
          basePriceMinor: Math.round(Number(s.basePrice) * 100),
          rowLabels: expandRowLabels(s.rowLabels),
          seatsPerRow: Number(s.seatsPerRow),
          seatKinds: seatKindsFor(s),
        })),
      };
      return api.shows.generateSeatMap(screenId, body);
    },
    onSuccess: () => {
      toast.push('Seat map generated.', 'success');
      qc.invalidateQueries({ queryKey: ['seatmap', screenId] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const validate = (): string | null => {
    for (const [i, s] of sections.entries()) {
      const n = i + 1;
      if (!s.name.trim()) return `Section ${n}: name is required.`;
      if (!s.categoryName.trim()) return `Section ${n}: category name is required.`;
      const price = Number(s.basePrice);
      if (!s.basePrice || !Number.isFinite(price) || price < 0)
        return `Section ${n}: enter a valid base price.`;
      if (expandRowLabels(s.rowLabels).length === 0)
        return `Section ${n}: add at least one row — a letter, or a range like A-T.`;
      const spr = Number(s.seatsPerRow);
      if (!s.seatsPerRow || !Number.isFinite(spr) || spr < 1)
        return `Section ${n}: seats per row must be at least 1.`;
    }
    return null;
  };

  const submit = () => {
    const err = validate();
    setErrors(err);
    if (err) return;
    generate.mutate();
  };

  const seatMap = seatMapQ.data;
  const capacity = capacitySummary(
    sections,
    plans.map((p) => {
      const n = Number(p.capacity);
      return Number.isFinite(n) && n > 0 ? n : null;
    }),
  );
  /*
    Never more (or fewer) seats than the organizer agreed to. When the room that will be created
    is not the number they asked for, they confirm the real number before anything is sold.
  */
  const needsConfirmation = capacity.differsFromRequest && confirmedBookable !== capacity.bookable;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={screen ? `${screen.name} · Seat map` : 'Seat map'}
        breadcrumbs={[
          { label: 'Venues & spaces', href: '/organizer/venues' },
          { label: 'Cinema', href: `/organizer/cinemas/${id}` },
          { label: 'Layout' },
        ]}
      />

      <SeatingExplainer current="layout" />

      {seatMapQ.isError ? (
        <ErrorState
          message="We couldn't load the seat map. Please try again."
          onRetry={() => seatMapQ.refetch()}
        />
      ) : seatMapQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : seatMap ? (
        <Card
          title={seatMap.name ?? 'Seat map'}
          action={
            <span className="flex flex-wrap gap-2">
              <ButtonLink
                size="sm"
                variant="secondary"
                href={`/organizer/cinemas/${id}/screens/${screenId}/layouts/${seatMap.id}/preview`}
              >
                <Eye className="mr-1.5 h-4 w-4" aria-hidden />
                Preview as buyer
              </ButtonLink>
              <ButtonLink
                size="sm"
                variant="outline"
                href={`/organizer/cinemas/${id}/screens/${screenId}/layouts`}
              >
                Layout versions
              </ButtonLink>
            </span>
          }
        >
          {/*
            The same five numbers the layout list and the buyer preview show, counted from these
            very seats by the shared rule.
          */}
          <div className="mb-4">
            <SeatCountSummary
              counts={reconcileSeats(
                countSeatKinds(
                  seatMap.sections.flatMap((sec) =>
                    sec.rows.flatMap((row) =>
                      row.seats.map((seat) => ({ kind: seat.kind ?? 'SEAT' })),
                    ),
                  ),
                ),
              )}
            />
          </div>
          <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-caption text-text-secondary">
            {seatMap.categories.map((c) => (
              <span key={c.id} className="flex items-center gap-1.5">
                <span
                  className="h-3.5 w-3.5 rounded border"
                  style={{
                    borderColor: c.colorHex ?? 'var(--border)',
                    backgroundColor: c.colorHex ? `${c.colorHex}22` : undefined,
                  }}
                />
                {c.name} · {money(c.basePriceMinor, roomCurrency)}
              </span>
            ))}
          </div>
          <div className="space-y-6 overflow-x-auto">
            {seatMap.sections.map((section) => (
              <div key={section.id}>
                <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-text-muted">
                  {section.name}
                </p>
                <div className="space-y-1.5">
                  {section.rows.map((row) => {
                    const sorted = [...row.seats].sort((a, b) => a.colIndex - b.colIndex);
                    return (
                      <div key={row.id} className="flex items-center gap-2">
                        <span className="w-6 shrink-0 text-center text-caption font-medium text-text-muted">
                          {row.label}
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {sorted.map((seat) => {
                            const cat = seatMap.categories.find(
                              (c) => c.id === seat.seatCategoryId,
                            );
                            const color = cat?.colorHex ?? undefined;
                            /*
                              An aisle is drawn as a space, not as a numbered seat. This view
                              used to ignore `kind`, so every aisle showed up as a bookable-looking
                              seat with a number on it - the opposite of what buyers are sold.
                            */
                            if (seat.kind === 'GAP') {
                              return (
                                <span
                                  key={seat.id}
                                  aria-hidden
                                  title={`${seat.label}: aisle, not sold`}
                                  className="h-7 w-7"
                                />
                              );
                            }
                            const accessible =
                              seat.kind === 'WHEELCHAIR' || seat.kind === 'COMPANION';
                            return (
                              <span
                                key={seat.id}
                                title={`${row.label}${seat.label}${cat ? ` - ${cat.name}` : ''}${
                                  seat.kind === 'WHEELCHAIR'
                                    ? ' - wheelchair space'
                                    : seat.kind === 'COMPANION'
                                      ? ' - companion seat'
                                      : ''
                                }`}
                                style={color ? { borderColor: color, color } : undefined}
                                className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background-surface text-[0.625rem] font-medium text-text-secondary"
                              >
                                {accessible ? (
                                  <Accessibility aria-hidden className="h-3.5 w-3.5" />
                                ) : (
                                  seat.label.replace(/^[A-Za-z]+/, '')
                                )}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card title="Generate seat map">
          <p className="mb-4 text-[0.9375rem] text-text-muted">
            This screen has no seat map yet. Start from a template, or describe the room yourself
            below. Each section gets a ticket category with its own price.
          </p>
          <div className="mb-6 space-y-3">
            <p className="text-sm font-medium text-text-primary">Start from a template</p>
            <LayoutTemplateGallery
              selectedId={chosen?.option.id ?? null}
              onChoose={chooseTemplate}
            />
            {chosen?.option.style === 'GRID' ? (
              <p
                role="status"
                className="rounded-md bg-tint-primary px-3 py-2 text-caption text-text-primary"
              >
                {chosen.option.label} is filled in below. Set a base price for each section, change
                anything you need, then generate it.
              </p>
            ) : chosen?.option.style === 'GA' ? (
              <div role="status" className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium text-text-primary">General admission needs no seat map</p>
                <p className="mt-1 text-text-muted">
                  Buyers do not choose a seat. When you create the event, give its ticket a number
                  of places, and that number is what you sell.
                </p>
                <ButtonLink
                  className="mt-3"
                  size="sm"
                  variant="secondary"
                  href="/organizer/events/new"
                >
                  Create an event
                </ButtonLink>
              </div>
            ) : chosen && chosen.option.template ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <p className="text-sm text-text-primary">
                  {chosen.option.label} is built as a draft layout of blocks around the{' '}
                  {chosen.outline?.focal.label.toLowerCase() ?? 'stage'}. You check it as a buyer
                  before you publish it.
                </p>
                <Input
                  id="venue-base-price"
                  label={`Cheapest seat (${currencySymbol})`}
                  type="number"
                  min={0}
                  hint="The other ticket categories are priced up from this. Change any of them later."
                  value={venueBasePrice}
                  onChange={(e) => setVenueBasePrice(e.target.value)}
                />
                <Button
                  loading={buildVenue.isPending}
                  disabled={
                    venueBasePrice.trim() === '' ||
                    !Number.isFinite(Number(venueBasePrice)) ||
                    Number(venueBasePrice) < 0
                  }
                  onClick={() => buildVenue.mutate()}
                >
                  Build draft and preview
                </Button>
              </div>
            ) : null}
          </div>
          <div className="space-y-4">
            <Input
              id="mapName"
              label="Seat map name (optional)"
              placeholder="e.g. Main auditorium"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />

            {sections.map((s, i) => {
              const preview = previewSection(s);
              return (
                <div key={i} className="space-y-4 rounded-lg border border-border p-4">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-text-primary">Section {i + 1}</p>
                    {sections.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-status-error"
                        onClick={() => removeSection(i)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {/*
                      ── SECTION vs CATEGORY ───────────────────────────────────────────
                      Two boxes side by side, both wanting a name, neither saying what for.
                      Reported as exactly that question.

                      A SECTION is a place in the room — the balcony, the stalls. It is how
                      seats are grouped on the map a buyer looks at.

                      A CATEGORY is a price tier — Premium, Regular. It is what a ticket type
                      is created from and what the seat costs.

                      They are usually the same word, which is why one form asks for both and
                      why nobody could tell them apart: a balcony IS the premium seats, most
                      of the time. They come apart when a room has two blocks at one price, or
                      one block sold at two.
                    */}
                    <Input
                      id={`sec-${i}-name`}
                      label="Section name"
                      placeholder="e.g. Balcony"
                      hint="Where it is in the space. Shown on the seat map."
                      value={s.name}
                      onChange={(e) => setSection(i, { name: e.target.value })}
                    />
                    <Input
                      id={`sec-${i}-cat`}
                      label="Ticket category"
                      placeholder="e.g. Premium"
                      hint="What these seats cost. Becomes a ticket type. Often the same idea as the section."
                      value={s.categoryName}
                      onChange={(e) => setSection(i, { categoryName: e.target.value })}
                    />
                    <Input
                      id={`sec-${i}-price`}
                      label={`Base price (${currencySymbol})`}
                      type="number"
                      min={0}
                      hint="The starting price. A showing can be priced above or below it."
                      value={s.basePrice}
                      onChange={(e) => setSection(i, { basePrice: e.target.value })}
                    />
                    <div>
                      <label
                        htmlFor={`sec-${i}-color`}
                        className="mb-1.5 block text-caption font-medium text-text-secondary"
                      >
                        Colour
                      </label>
                      {/*
                        A swatch AND a hex box.

                        The native colour input is a picker and nothing else: an organizer with
                        a brand colour in hand had no way to enter it, only to hunt for it by
                        eye. The two are bound to one value, so either way of choosing shows up
                        in the other.
                      */}
                      <div className="flex gap-2">
                        <input
                          id={`sec-${i}-color`}
                          type="color"
                          value={s.colorHex}
                          onChange={(e) => setSection(i, { colorHex: e.target.value })}
                          className="h-10 w-14 shrink-0 cursor-pointer rounded-md border border-border bg-background-surface p-1"
                        />
                        <input
                          aria-label="Colour hex code"
                          value={s.colorHex}
                          spellCheck={false}
                          placeholder="#2563EB"
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            const withHash = raw.startsWith('#') ? raw : `#${raw}`;
                            /*
                              Written through only when it is a colour. A half-typed "#2b" is
                              left in the box but not applied, so the swatch never flickers
                              through wrong colours while somebody types six characters.
                            */
                            setSection(i, {
                              colorHex: /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash : raw,
                            });
                          }}
                          className="h-10 w-full rounded-md border border-border bg-background-surface px-3 font-mono text-[0.9375rem] uppercase text-text-primary"
                        />
                      </div>
                    </div>
                  </div>

                  {/*
                    The room, described the way an organizer knows it.

                    This replaced a "Rows" box wanting "A-T" and a "Seats per row" box. Both
                    are still here, under "Set it exactly" — but nobody has to open them to
                    describe an ordinary cinema any more.
                  */}
                  <RoomShapePicker
                    shapeKey={plans[i]?.shapeKey ?? DEFAULT_SHAPE.key}
                    capacity={plans[i]?.capacity ?? ''}
                    onChange={(next) => applyPlan(i, next)}
                  />

                  <details
                    open={exact.has(i)}
                    onToggle={(e) => {
                      /*
                        Read the flag BEFORE the state update, not inside it.

                        React nulls a synthetic event's `currentTarget` once the handler
                        returns, and a state updater runs after that — so reading it in there
                        threw, and the whole page fell over with a client-side exception the
                        moment anyone opened this panel.
                      */
                      const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                      setExact((prev) => {
                        const nx = new Set(prev);
                        if (isOpen) nx.add(i);
                        else nx.delete(i);
                        return nx;
                      });
                    }}
                    className="rounded-lg border border-border"
                  >
                    <summary className="cursor-pointer select-none px-3 py-2 text-caption font-medium text-text-secondary">
                      Set it exactly — {s.rowLabels ? previewSection(s).rows.length : 0} rows ×{' '}
                      {s.seatsPerRow || 0}
                    </summary>
                    <div className="grid gap-4 border-t border-border p-3 sm:grid-cols-2">
                      <Input
                        id={`sec-${i}-rows`}
                        label="Rows"
                        hint="A range like A-T, or a list like A, B, C. Mix them freely."
                        placeholder="A-T"
                        value={s.rowLabels}
                        onChange={(e) => setSection(i, { rowLabels: e.target.value })}
                      />
                      <Input
                        id={`sec-${i}-spr`}
                        label="Seats per row"
                        type="number"
                        min={1}
                        placeholder="20"
                        value={s.seatsPerRow}
                        onChange={(e) => setSection(i, { seatsPerRow: e.target.value })}
                      />
                    </div>
                  </details>

                  {/*
                  Accessible seating, which the data model always supported and the product
                  never let anyone create. One input describes every row in the section,
                  because an accessible bay runs down the same side of a block — twenty
                  inputs for twenty rows would be the same unusable shape as typing the row
                  labels out by hand.
                */}
                  <details className="mt-4 rounded-md border border-border">
                    <summary className="cursor-pointer px-3 py-2 text-caption font-medium text-text-secondary">
                      Accessible seating and aisles
                      {preview.wheelchair + preview.companion + preview.gaps > 0
                        ? ` · ${preview.wheelchair} wheelchair, ${preview.companion} companion, ${preview.gaps} gap`
                        : ' · none set'}
                    </summary>
                    <div className="grid gap-4 border-t border-border p-3 sm:grid-cols-3">
                      <Input
                        id={`sec-${i}-wheel`}
                        label="Wheelchair spaces"
                        hint="Seat numbers, e.g. 1-2"
                        value={s.wheelchairSeats}
                        onChange={(e) => setSection(i, { wheelchairSeats: e.target.value })}
                      />
                      <Input
                        id={`sec-${i}-companion`}
                        label="Companion seats"
                        hint="Beside a wheelchair space"
                        value={s.companionSeats}
                        onChange={(e) => setSection(i, { companionSeats: e.target.value })}
                      />
                      <Input
                        id={`sec-${i}-gap`}
                        label="Aisle gaps"
                        hint="Positions that are not seats"
                        value={s.gapSeats}
                        onChange={(e) => setSection(i, { gapSeats: e.target.value })}
                      />
                    </div>
                  </details>

                  {/*
                  The preview is what makes a large room manageable. Typing `A-T` and `20` is
                  fast, but nobody can tell from those two fields whether they have just
                  described the 400-seat house they meant — so the room is drawn, and counted.
                */}
                  {preview.total > 0 ? (
                    <div className="mt-4 rounded-md border border-border bg-background-subtle/40 p-3">
                      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-caption font-medium text-text-primary">
                          {preview.rows.length} row{preview.rows.length === 1 ? '' : 's'} ·{' '}
                          {preview.sellable} bookable seat{preview.sellable === 1 ? '' : 's'}
                        </span>
                        {preview.wheelchair > 0 ? (
                          <span className="text-caption text-text-muted">
                            includes {preview.wheelchair} wheelchair space
                            {preview.wheelchair === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </div>
                      <div className="max-h-56 overflow-auto">
                        <div className="inline-block min-w-full space-y-1">
                          {preview.rows.map((row) => (
                            <div key={row.label} className="flex items-center gap-1">
                              <span className="w-6 shrink-0 text-right text-[0.625rem] font-medium text-text-muted">
                                {row.label}
                              </span>
                              {row.seats.map((seat) => (
                                <span
                                  key={seat.position}
                                  title={`${row.label}${seat.position} · ${seat.kind.toLowerCase()}`}
                                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[2px] border text-[0.5rem] ${KIND_STYLE[seat.kind]}`}
                                >
                                  {seat.kind === 'WHEELCHAIR' ? '♿' : ''}
                                </span>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                      <p className="mt-2 text-caption text-text-muted">
                        Aisle gaps are drawn as blanks and sell nothing. Screen is at the top.
                      </p>
                    </div>
                  ) : null}
                </div>
              );
            })}

            {/*
              One set of numbers for the whole room, from the draft that will actually be sent.
              Bookable is the headline because it is what the room sells; the rest explain it.
            */}
            {capacity.positions > 0 ? (
              <div
                data-testid="capacity-summary"
                className="rounded-md border border-border bg-background-subtle/40 p-3"
              >
                <p className="text-[0.9375rem] text-text-primary">
                  This screen will sell{' '}
                  <strong data-testid="bookable-count">{capacity.bookable}</strong> seat
                  {capacity.bookable === 1 ? '' : 's'} across {sections.length} section
                  {sections.length === 1 ? '' : 's'}.
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-caption sm:grid-cols-4">
                  {capacity.requested !== null ? (
                    <div>
                      <dt className="text-text-muted">You asked for</dt>
                      <dd className="tabular-nums text-text-primary">{capacity.requested}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-text-muted">Seat positions</dt>
                    <dd className="tabular-nums text-text-primary">{capacity.positions}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">Aisle spaces (not sold)</dt>
                    <dd className="tabular-nums text-text-primary">{capacity.aisles}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">Accessible places (sold)</dt>
                    <dd className="tabular-nums text-text-primary">{capacity.accessible}</dd>
                  </div>
                </dl>
                {capacity.differsFromRequest ? (
                  <label className="mt-3 flex items-start gap-2 rounded-md bg-tint-warning px-3 py-2 text-caption text-text-primary">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={confirmedBookable === capacity.bookable}
                      onChange={(e) =>
                        setConfirmedBookable(e.target.checked ? capacity.bookable : null)
                      }
                    />
                    <span>
                      You asked for {capacity.requested} but this layout sells {capacity.bookable}.
                      Change the room size, or confirm that {capacity.bookable} seats is right.
                    </span>
                  </label>
                ) : null}
              </div>
            ) : null}

            <Button variant="outline" size="sm" onClick={addSection}>
              Add section
            </Button>

            {errors && (
              <p role="alert" className="text-caption text-status-error">
                {errors}
              </p>
            )}

            <div>
              <Button loading={generate.isPending} disabled={needsConfirmation} onClick={submit}>
                Generate seat map
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
