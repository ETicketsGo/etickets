'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Card, Select, Skeleton, errorMessage, money, useToast } from '@eticketsgo/web-kit';

/**
 * Mapping what an operator calls a seat to what a regulator prices it as.
 *
 * ── WHY THIS SCREEN EXISTS AT ALL ──────────────────────────────────────────────────
 * A rate order bands on a handful of fixed classes. Operators name seats whatever sells them:
 * Gold, Platinum, Executive, Lounger, VIP. The platform used to match one against the other by
 * comparing strings, so a category called "Recliner" was capped at the recliner rate and the
 * identical seat called "Lounger" matched nothing and sold with no ceiling at all.
 *
 * Nobody can fix that by choosing better names. The operator has to say which is which, and
 * this is where they say it.
 *
 * ── WHY EVERY CATEGORY IS LISTED, NOT ONLY THE UNMAPPED ONES ───────────────────────
 * A missing mapping refuses the sale, loudly, at checkout. A WRONG mapping sells legally at
 * the wrong ceiling and nothing ever complains. The second is the more expensive mistake, so
 * the screen is built for reviewing all of them rather than for clearing a to-do list.
 */
const CLASSES = [
  { value: '', label: 'Not mapped' },
  { value: 'REGULAR', label: 'Regular' },
  { value: 'RECLINER', label: 'Recliner' },
  { value: 'PREMIUM', label: 'Premium' },
  { value: 'NON_PREMIUM', label: 'Non-premium' },
];

export function SeatClassMapping({ cinemaId }: { cinemaId: string }) {
  const qc = useQueryClient();
  const toast = useToast();

  const q = useQuery({
    queryKey: ['cinema-seat-classes', cinemaId],
    queryFn: () => api.cinemas.seatClasses(cinemaId),
  });

  const save = useMutation({
    mutationFn: ({ seatCategoryId, value }: { seatCategoryId: string; value: string }) =>
      api.cinemas.setSeatClass(cinemaId, seatCategoryId, value === '' ? null : value),
    onSuccess: async () => {
      toast.push('Seat class saved.');
      await qc.invalidateQueries({ queryKey: ['cinema-seat-classes', cinemaId] });
      // The compliance panel prices every ticket against these classes, so it is now stale.
      await qc.invalidateQueries({ queryKey: ['cinema-pricing-compliance', cinemaId] });
    },
    onError: (e) => toast.push(errorMessage(e)),
  });

  if (q.isLoading) {
    return (
      <Card title="Seat classes">
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }
  if (q.isError || !q.data || q.data.length === 0) return null;

  const unmapped = q.data.filter((c) => !c.mapped).length;

  return (
    <Card title="Seat classes">
      <p className="mb-4 text-[0.9375rem] text-text-secondary">
        Rate orders set a maximum price per class of seat. Tell us which class each of your seat
        categories belongs to — we don’t guess it from the name, because a “Lounger” and a
        “Recliner” are the same seat to a regulator and different strings to a computer.
      </p>

      {unmapped > 0 && (
        <p
          role="status"
          className="mb-4 rounded-md bg-status-warning/10 px-3 py-2 text-[0.9375rem] text-status-warning"
        >
          {unmapped === 1
            ? '1 seat category is not mapped yet. It cannot be sold in a regulated area until it is.'
            : `${unmapped} seat categories are not mapped yet. They cannot be sold in a regulated area until they are.`}
        </p>
      )}

      <ul className="space-y-3">
        {q.data.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium text-text-primary">{c.name}</div>
              <div className="text-caption text-text-muted">
                from {money(c.basePriceMinor, 'INR')}
              </div>
            </div>
            <Select
              // No visible label: the seat category's name is right beside it. `aria-label`
              // rather than nothing, so the control still announces which seat it changes.
              aria-label={`Regulatory class for ${c.name}`}
              value={c.regulatoryClass ?? ''}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ seatCategoryId: c.id, value: e.target.value })}
            >
              {CLASSES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </li>
        ))}
      </ul>
    </Card>
  );
}
