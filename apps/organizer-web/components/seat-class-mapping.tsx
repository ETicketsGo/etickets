'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  aboveClassLimit,
  classHasNoRate,
  classOptionLabel,
  missingRateWarning,
} from './compliance-presentation';
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

  /*
    Arriving by a "Choose seat classes" link (the create wizard, an event's blocker) the browser
    looks for #seat-classes before this card exists - it loads after the page - and the person
    lands at the top of a dozen checks. Scrolled to once the card is there.
  */
  const ready = Boolean(q.data && q.data.length > 0);
  useEffect(() => {
    if (!ready || typeof window === 'undefined' || window.location.hash !== '#seat-classes') return;
    const go = () => document.getElementById('seat-classes')?.scrollIntoView({ block: 'start' });
    go();
    // The panels above load on their own and push this down; once more after they have.
    const later = window.setTimeout(go, 1200);
    return () => window.clearTimeout(later);
  }, [ready]);

  if (q.isLoading) {
    return (
      <Card title="Seat classes">
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }
  if (q.isError || !q.data || q.data.length === 0) return null;

  const unmapped = q.data.filter((c) => !c.mapped).length;
  // The same limits for every category of this cinema; read once for the option labels.
  const rates = q.data[0]?.classRates;
  const regulated = (rates ?? []).some((r) => r.regulated);
  // A state with no rules at all (Telangana): no class sells, so one sentence, not one per seat.
  const noRules = regulated && (rates ?? []).every((r) => r.status === 'POLICY_NOT_FOUND');

  return (
    // `id` so a readiness blocker can link straight here ("Set it under Seat classes").
    <div id="seat-classes" className="scroll-mt-24">
      <Card title="Seat classes">
        <p className="mb-4 text-[0.9375rem] text-text-secondary">
          {regulated
            ? 'The state sets the most a ticket may cost for each class of seat. Choose the class each of your seat categories is sold as. We do not guess it from the name: a "Lounger" and a "Recliner" are the same seat to the state. Each choice shows its limit here.'
            : 'Rate orders set a maximum price per class of seat. Choose the class each of your seat categories belongs to. We do not guess it from the name.'}
        </p>

        {noRules ? (
          <p
            role="status"
            className="mb-4 rounded-md bg-tint-warning px-3 py-2 text-[0.9375rem] text-status-warning"
          >
            This state has no cinema pricing rules on record yet, so no seat here can be sold online
            until ETicketsGo adds them. Map your seat categories now and they will be ready.
          </p>
        ) : null}

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
                {/*
                In the cinema's own currency - currency follows the venue. This printed rupees
                for every cinema, a US one included. No currency means a country we do not
                sell in, and no price is better than a price in the wrong money.
              */}
                {c.currency ? (
                  <div className="text-caption text-text-muted">
                    from {money(c.basePriceMinor, c.currency)}
                  </div>
                ) : null}
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
                    {/*
                      The limit on the option itself: "Regular - up to Rs 150" next to a Rs 200
                      category says which class it cannot be before anyone picks it.
                    */}
                    {o.value === ''
                      ? o.label
                      : regulated
                        ? classOptionLabel(o.value, rates, (m) => money(m, c.currency ?? 'INR'))
                        : `${o.label}${classHasNoRate(c.classHasRate, o.value) ? ' (no rate for this cinema)' : ''}`}
                  </option>
                ))}
              </Select>
              {/* Read-only: the server's own answer on whether this cinema's order prices the class. */}
              {aboveClassLimit(c, (m) => money(m, c.currency ?? 'INR')) && (
                <p
                  role="status"
                  className="w-full rounded-md bg-tint-warning px-3 py-2 text-caption text-status-warning"
                >
                  {aboveClassLimit(c, (m) => money(m, c.currency ?? 'INR'))}
                </p>
              )}
              {!noRules && missingRateWarning(c) && (
                <p
                  role="status"
                  className="w-full rounded-md bg-tint-warning px-3 py-2 text-caption text-status-warning"
                >
                  {missingRateWarning(c)}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
