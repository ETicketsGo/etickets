'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, Button, Dialog, Input, useToast, type ShowRow } from '@eticketsgo/web-kit';
import { explainMutationError, formatLocalTime } from './show-status';
import {
  changedRows,
  differsFromHouse,
  formatMinor,
  lockReason,
  minorToInput,
  parseDraft,
  showLockReason,
  type PriceDraft,
} from './pricing-presentation';

/**
 * Set what one show charges.
 *
 * ── WHY THIS LIVES ON THE SHOW ────────────────────────────────────────────────────
 * Price belongs to the show, not to the room. The seat layout says where people sit; the
 * ticket type says what that seat costs tonight. Two showings of the same film in the same
 * room can be priced differently, and changing a price does not touch the layout — proven
 * end to end before this screen was written, because the working assumption had been the
 * opposite (that a price change meant cloning and republishing a layout version).
 *
 * ── WHY THE WHOLE SHOW AT ONCE ────────────────────────────────────────────────────
 * The server applies all categories in one transaction. Repricing a house is one commercial
 * decision, and three independent requests is how a screen ends up half at the old price.
 *
 * ── WHAT IS NOT NEGOTIABLE ────────────────────────────────────────────────────────
 * A category that has SOLD is fixed, and the field says why rather than just going grey. A
 * price somebody has paid is history. Held seats do not lock anything: the buyer's line was
 * snapshotted when they held it, so the two cannot disagree.
 */
export function ShowPricingDialog({
  show,
  timezone,
  onClose,
  onSaved,
}: {
  show: ShowRow;
  /** The cinema's IANA zone. Never the browser's. */
  timezone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<PriceDraft>({});
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['show', show.sessionId, 'pricing'],
    queryFn: () => api.shows.pricing(show.sessionId),
    // Money: never render a cached price from before somebody else's edit.
    staleTime: 0,
  });

  const pricing = q.data;
  const parsed = pricing ? parseDraft(pricing, draft) : { prices: [], problems: [] };
  const changed = pricing ? changedRows(pricing, parsed.prices) : [];
  const blocked = pricing ? showLockReason(pricing, new Date()) : null;
  const everyRowLocked =
    Boolean(pricing?.categories.length) && pricing!.categories.every((c) => c.locked);

  const save = useMutation({
    mutationFn: () => api.shows.updatePricing(show.sessionId, parsed.prices),
    onSuccess: (next) => {
      toast.push(`Prices updated for ${formatLocalTime(next.startsAt, timezone)}.`, 'success');
      onSaved();
    },
    // Refusals belong next to the fields, not in a toast that scrolls away.
    onError: (e) => setError(explainMutationError(e)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Show pricing"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={
              save.isPending ||
              !pricing ||
              Boolean(blocked) ||
              parsed.problems.length > 0 ||
              changed.length === 0
            }
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            {changed.length > 1 ? `Save ${changed.length} prices` : 'Save price'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-text-muted">Movie</dt>
          <dd className="font-medium">{show.movieTitle ?? 'Untitled'}</dd>
          <dt className="text-text-muted">Screen</dt>
          <dd>{show.screenName ?? '—'}</dd>
          <dt className="text-text-muted">Starts</dt>
          <dd>{formatLocalTime(show.startsAt, timezone)}</dd>
        </dl>

        {q.isLoading ? <p className="text-sm text-text-muted">Loading prices…</p> : null}
        {q.isError ? (
          <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
            {explainMutationError(q.error)}
          </p>
        ) : null}

        {blocked ? (
          <p role="alert" className="rounded-md bg-status-warning/10 p-3 text-sm">
            {blocked}
          </p>
        ) : null}

        {pricing && pricing.categories.length === 0 ? (
          <p className="rounded-md bg-background-subtle p-3 text-sm text-text-muted">
            This show has no seat categories to price.
          </p>
        ) : null}

        {pricing && pricing.categories.length > 0 ? (
          <div className="space-y-3" data-testid="pricing-rows">
            {pricing.categories.map((cat) => {
              const locked = lockReason(cat);
              const house = differsFromHouse(cat);
              const problem = parsed.problems.find((p) => p.ticketTypeId === cat.ticketTypeId);
              const fieldId = `price-${cat.ticketTypeId}`;
              return (
                <div key={cat.ticketTypeId} data-testid={`pricing-row-${cat.name}`}>
                  <label htmlFor={fieldId} className="mb-1 block text-sm font-medium">
                    {cat.name}
                    <span className="ml-2 font-normal text-text-muted">
                      {cat.seatCount} seats
                      {cat.soldCount > 0 ? ` · ${cat.soldCount} sold` : ''}
                    </span>
                  </label>
                  <div className="flex items-center gap-2">
                    {/* The unit is stated, not implied by a placeholder that vanishes on focus. */}
                    <span aria-hidden className="text-sm text-text-muted">
                      ₹
                    </span>
                    <Input
                      id={fieldId}
                      inputMode="decimal"
                      // Not type=number: it silently accepts `1e5` and browsers disagree
                      // about what a scroll wheel over a focused field should do to money.
                      type="text"
                      aria-label={`${cat.name} price in rupees`}
                      aria-describedby={
                        problem ? `${fieldId}-problem` : locked ? `${fieldId}-locked` : undefined
                      }
                      aria-invalid={problem ? true : undefined}
                      disabled={cat.locked || Boolean(blocked)}
                      value={draft[cat.ticketTypeId] ?? minorToInput(cat.priceMinor)}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [cat.ticketTypeId]: e.target.value }))
                      }
                    />
                  </div>
                  {problem ? (
                    <p
                      id={`${fieldId}-problem`}
                      role="alert"
                      className="mt-1 text-caption text-status-error"
                    >
                      {problem.message}
                    </p>
                  ) : null}
                  {locked ? (
                    <p id={`${fieldId}-locked`} className="mt-1 text-caption text-text-muted">
                      {locked}
                    </p>
                  ) : null}
                  {!locked && house ? (
                    <p className="mt-1 text-caption text-text-muted">
                      {house} — changing it here affects this show only.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {everyRowLocked && !blocked ? (
          <p className="rounded-md bg-background-subtle p-3 text-caption text-text-muted">
            Every category has sold, so this show&rsquo;s prices are fixed. Future shows are
            unaffected.
          </p>
        ) : null}

        {pricing && !blocked ? (
          <p className="rounded-md bg-background-subtle p-2 text-caption text-text-muted">
            This changes {formatLocalTime(show.startsAt, timezone)} only. Other showings, and the
            layout&rsquo;s own house prices, are untouched. Anyone already holding a seat keeps the
            price they were quoted.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
            {error}
          </p>
        ) : null}

        {/* A running total, because "did I just triple the balcony" is the question. */}
        {pricing && changed.length > 0 ? (
          <p className="text-caption text-text-muted" data-testid="pricing-summary">
            {changed
              .map((c) => {
                const cat = pricing.categories.find((x) => x.ticketTypeId === c.ticketTypeId)!;
                return `${cat.name} ${formatMinor(cat.priceMinor, cat.currency)} → ${formatMinor(
                  c.priceMinor,
                  cat.currency,
                )}`;
              })
              .join(' · ')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
