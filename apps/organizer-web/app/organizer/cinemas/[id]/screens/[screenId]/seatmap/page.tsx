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

interface SectionDraft {
  name: string;
  categoryName: string;
  colorHex: string;
  basePrice: string; // rupees, converted to minor on submit
  rowLabels: string; // comma-separated
  seatsPerRow: string;
}

const emptySection: SectionDraft = {
  name: '',
  categoryName: '',
  colorHex: '#2563EB',
  basePrice: '',
  rowLabels: '',
  seatsPerRow: '',
};

const splitList = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

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
  const [errors, setErrors] = useState<string | null>(null);

  const setSection = (idx: number, patch: Partial<SectionDraft>) =>
    setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  const addSection = () => setSections((prev) => [...prev, { ...emptySection }]);
  const removeSection = (idx: number) =>
    setSections((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));

  const generate = useMutation({
    mutationFn: () => {
      const body: GenerateSeatMapBody = {
        name: name.trim() || undefined,
        sections: sections.map((s) => ({
          name: s.name.trim(),
          categoryName: s.categoryName.trim(),
          colorHex: s.colorHex || undefined,
          basePriceMinor: Math.round(Number(s.basePrice) * 100),
          rowLabels: splitList(s.rowLabels),
          seatsPerRow: Number(s.seatsPerRow),
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
      if (splitList(s.rowLabels).length === 0)
        return `Section ${n}: add at least one row label.`;
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

            {sections.map((s, i) => (
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
                  <Input
                    id={`sec-${i}-rows`}
                    label="Row labels"
                    hint="Comma-separated, e.g. A, B, C"
                    value={s.rowLabels}
                    onChange={(e) => setSection(i, { rowLabels: e.target.value })}
                  />
                  <Input
                    id={`sec-${i}-spr`}
                    label="Seats per row"
                    type="number"
                    min={1}
                    value={s.seatsPerRow}
                    onChange={(e) => setSection(i, { seatsPerRow: e.target.value })}
                  />
                </div>
              </div>
            ))}

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
