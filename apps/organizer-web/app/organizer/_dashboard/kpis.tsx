import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { IconTile, type TileTone } from '@eticketsgo/web-kit';

export interface Kpi {
  key: string;
  label: string;
  value: string;
  /** What the number counts, in one line. Always visible: a figure nobody can define is not a figure. */
  definition: string;
  /** A second, real fact about the same number (checked in, in the next 7 days), when there is one. */
  fact?: string;
  icon: LucideIcon;
  tile: TileTone;
  href?: string;
  /** Red value text for a count that is bad when above zero. */
  alert?: boolean;
}

/**
 * Four figures that say what to do next, each with its definition under it.
 *
 * The definition is visible text rather than a tooltip: a phone has no hover, and the old cards
 * said "Valid tickets buyers hold" or nothing, so two readers could take "Upcoming events" to
 * mean different things (it counted drafts).
 */
export function KpiRow({ kpis }: { kpis: Kpi[] }) {
  return (
    <section aria-label="Key figures">
      <ul className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
        {kpis.map((k) => {
          const body = (
            <>
              <div className="flex min-w-0 items-center gap-2.5">
                <IconTile icon={k.icon} tone={k.tile} size="sm" />
                <p className="min-w-0 text-caption font-medium leading-tight text-text-secondary">
                  {k.label}
                </p>
              </div>
              <p
                className={`mt-2 font-display text-[1.625rem] font-bold leading-none tracking-tight tabular-nums ${
                  k.alert ? 'text-status-error' : 'text-text-primary'
                }`}
              >
                {k.value}
              </p>
              {k.fact ? (
                <p className="mt-1 text-caption font-medium tabular-nums text-text-secondary">
                  {k.fact}
                </p>
              ) : null}
              <p className="mt-1 text-micro leading-snug text-text-muted">{k.definition}</p>
            </>
          );
          const frame =
            'block h-full min-w-0 rounded-lg border border-border bg-background-surface p-3.5 shadow-xs sm:p-4';
          return (
            <li key={k.key} className="min-w-0">
              {k.href ? (
                <Link
                  href={k.href}
                  className={`${frame} transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0`}
                >
                  {body}
                </Link>
              ) : (
                <div className={frame}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
