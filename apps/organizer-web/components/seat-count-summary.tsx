import type { SeatReconciliation } from '@eticketsgo/shared-types';

/**
 * The same five numbers wherever a layout is shown: positions, aisles, blocked, accessible,
 * bookable. Fed by `reconcileSeats`, so the generator, the layout list and the buyer preview
 * cannot disagree about one room.
 *
 * Bookable is the headline because it is what the room sells. The rest explain how the room
 * got from "positions on the plan" to that number.
 */
export function SeatCountSummary({
  counts,
  /** True on a layout: blocked seats belong to a session, so the figure is always 0 here. */
  layoutOnly = true,
  compact = false,
}: {
  counts: SeatReconciliation;
  layoutOnly?: boolean;
  compact?: boolean;
}) {
  const items: { label: string; value: number; testid: string }[] = [
    { label: 'Seat positions', value: counts.positions, testid: 'positions' },
    { label: 'Aisle spaces (not sold)', value: counts.aisles, testid: 'aisles' },
    {
      label: layoutOnly ? 'Blocked (set per session)' : 'Blocked',
      value: counts.blocked,
      testid: 'blocked',
    },
    { label: 'Accessible places (sold)', value: counts.accessible, testid: 'accessible' },
  ];
  if (compact) {
    return (
      <p data-testid="seat-reconciliation" className="text-caption text-text-muted">
        <strong className="tabular-nums text-text-primary" data-testid="reconciled-bookable">
          {counts.bookable.toLocaleString()}
        </strong>{' '}
        bookable of {counts.positions.toLocaleString()} positions, {counts.aisles} aisle
        {counts.aisles === 1 ? '' : 's'}, {counts.accessible} accessible
      </p>
    );
  }
  return (
    <div
      data-testid="seat-reconciliation"
      className="rounded-md border border-border bg-background-subtle/40 p-3"
    >
      <p className="text-[0.9375rem] text-text-primary">
        Buyers can book{' '}
        <strong className="tabular-nums" data-testid="reconciled-bookable">
          {counts.bookable.toLocaleString()}
        </strong>{' '}
        seat{counts.bookable === 1 ? '' : 's'}.
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-caption sm:grid-cols-4">
        {items.map((item) => (
          <div key={item.testid}>
            <dt className="text-text-muted">{item.label}</dt>
            <dd
              className="tabular-nums text-text-primary"
              data-testid={`reconciled-${item.testid}`}
            >
              {item.value.toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
