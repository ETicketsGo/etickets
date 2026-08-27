'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
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
} from '@eticketsgo/web-kit';
import {
  expandRowLabels,
  previewSection,
  seatKindsFor,
  type SeatKind,
  type SectionDraft,
} from '@/lib/seat-layout';
import { RoomShapePicker } from '@/components/room-shape-picker';
import { ROOM_SHAPES, planRoom } from '@/lib/room-plan';

/**
 * A section starts as a STANDARD SCREEN of its typical size, already planned.
 *
 * Not blank. An empty form asking for row labels is the thing organizers reported twice as
 * too hard; opening on a real, editable room means the common case is "adjust the number"
 * rather than "work out the arithmetic".
 */
const DEFAULT_SHAPE = ROOM_SHAPES[1];
const DEFAULT_PLAN = planRoom(DEFAULT_SHAPE.typicalSeats, DEFAULT_SHAPE);

const emptySection: SectionDraft = {
  name: '',
  categoryName: '',
  colorHex: '#2563EB',
  basePrice: '',
  rowLabels: DEFAULT_PLAN.rowLabels.join(', '),
  seatsPerRow: String(DEFAULT_PLAN.seatsPerRow),
  wheelchairSeats: '',
  companionSeats: '',
  gapSeats: '',
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

  const seatMapQ = useQuery({
    queryKey: ['seatmap', screenId],
    queryFn: () => api.shows.getSeatMap(screenId),
  });
  const screensQ = useQuery({
    queryKey: ['cinema', id, 'screens'],
    queryFn: () => api.cinemas.screens(id),
  });
  const screen = screensQ.data?.find((s) => s.id === screenId);

  const [name, setName] = useState('');
  const [sections, setSections] = useState<SectionDraft[]>([{ ...emptySection }]);
  /*
    The shape and capacity a section was planned FROM, kept alongside the draft.

    Not derived back out of rowLabels: two different shapes can produce the same grid, so
    reading the intent from the result would make the picker jump to a shape the organizer
    never chose. This is what they said; the draft is what it produced.
  */
  const [plans, setPlans] = useState<{ shapeKey: string; capacity: string }[]>([
    { shapeKey: DEFAULT_SHAPE.key, capacity: String(DEFAULT_SHAPE.typicalSeats) },
  ]);
  /** Which sections have the exact row/seat fields open. Closed by default. */
  const [exact, setExact] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<string | null>(null);

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
      { shapeKey: DEFAULT_SHAPE.key, capacity: String(DEFAULT_SHAPE.typicalSeats) },
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
    setPlans((prev) =>
      prev.map((p, i) => (i === idx ? { shapeKey: next.shapeKey, capacity: next.capacity } : p)),
    );
    if (!Number.isFinite(Number(next.capacity)) || Number(next.capacity) < 1) return;

    /*
      The suggested aisle is written in, but only into an EMPTY box.

      The picker tells the organizer an aisle is suggested, so it has to actually appear —
      a suggestion that leaves the field blank is just a sentence. Overwriting an aisle they
      positioned themselves would be worse than never offering one, so a box with anything in
      it is left exactly as they left it.
    */
    const current = sections[idx];
    const aisle = next.plan.aisle;
    setSection(idx, {
      rowLabels: next.plan.rowLabels.join(', '),
      seatsPerRow: String(next.plan.seatsPerRow),
      ...(aisle !== null && !current?.gapSeats?.trim() ? { gapSeats: String(aisle) } : {}),
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
  const totalSellable = sections.reduce((n, sec) => n + previewSection(sec).sellable, 0);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={screen ? `${screen.name} · Seat map` : 'Seat map'}
        breadcrumbs={[
          { label: 'Cinemas', href: '/organizer/cinemas' },
          { label: 'Cinema', href: `/organizer/cinemas/${id}` },
          { label: 'Seat map' },
        ]}
      />

      {seatMapQ.isError ? (
        <ErrorState
          message="We couldn't load the seat map. Please try again."
          onRetry={() => seatMapQ.refetch()}
        />
      ) : seatMapQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : seatMap ? (
        <Card title={seatMap.name ?? 'Seat map'}>
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
                {c.name} · {money(c.basePriceMinor)}
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
                            return (
                              <span
                                key={seat.id}
                                title={`${seat.label}${cat ? ` · ${cat.name}` : ''}`}
                                style={color ? { borderColor: color, color } : undefined}
                                className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background-surface text-[0.625rem] font-medium text-text-secondary"
                              >
                                {seat.label.replace(/^[A-Za-z]+/, '')}
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
            This screen has no seat map yet. Define one or more sections — each becomes a seat
            category with its own price and rows.
          </p>
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
                    <Input
                      id={`sec-${i}-name`}
                      label="Section name"
                      placeholder="e.g. Balcony"
                      value={s.name}
                      onChange={(e) => setSection(i, { name: e.target.value })}
                    />
                    <Input
                      id={`sec-${i}-cat`}
                      label="Category name"
                      placeholder="e.g. Premium"
                      value={s.categoryName}
                      onChange={(e) => setSection(i, { categoryName: e.target.value })}
                    />
                    <Input
                      id={`sec-${i}-price`}
                      label="Base price (₹)"
                      type="number"
                      min={0}
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
                      <input
                        id={`sec-${i}-color`}
                        type="color"
                        value={s.colorHex}
                        onChange={(e) => setSection(i, { colorHex: e.target.value })}
                        className="h-10 w-full cursor-pointer rounded-md border border-border bg-background-surface p-1"
                      />
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

            {/* One number for the whole room, which is the figure an operator actually knows. */}
            {totalSellable > 0 ? (
              <p className="text-caption text-text-secondary">
                This screen will have <strong className="text-text-primary">{totalSellable}</strong>{' '}
                bookable seats across {sections.length} section
                {sections.length === 1 ? '' : 's'}.
              </p>
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
              <Button loading={generate.isPending} onClick={submit}>
                Generate seat map
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
