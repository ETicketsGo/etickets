import { Skeleton } from '@eticketsgo/web-kit';

/**
 * A list loading, in the shape of the table it becomes: a header bar, then compact rows of
 * cells on a tablet or desktop, and stacked cards on a phone (these lists use `mobile="cards"`).
 * The bare grey bars the table showed while loading were a different height from its rows, so
 * the page jumped when the data landed.
 */
export function TableSkeleton({
  columns = 6,
  rows = 8,
  label = 'Loading',
}: {
  columns?: number;
  rows?: number;
  label?: string;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <div className="hidden overflow-hidden rounded-lg border border-border bg-background-surface sm:block">
        <div className="flex gap-4 border-b border-border bg-background-subtle px-4 py-3">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-3 flex-1 bg-border" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="flex min-h-[2.75rem] items-center gap-4 border-b border-border px-4 py-2.5 last:border-0"
          >
            {Array.from({ length: columns }).map((_, c) => (
              <Skeleton key={c} className={`h-3.5 flex-1 ${c === 0 ? 'max-w-[9rem]' : ''}`} />
            ))}
          </div>
        ))}
      </div>
      <div className="space-y-2.5 sm:hidden">
        {Array.from({ length: Math.min(rows, 5) }).map((_, r) => (
          <div
            key={r}
            className="space-y-2.5 rounded-lg border border-border bg-background-surface p-4"
          >
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-5/6" />
          </div>
        ))}
      </div>
    </div>
  );
}
