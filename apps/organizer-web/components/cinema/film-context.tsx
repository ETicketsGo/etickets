'use client';

import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import { ArrowRight, Building2, MonitorPlay, Scale } from 'lucide-react';
import { api, IconTile, Skeleton, money, type ShowRow } from '@eticketsgo/web-kit';
import { cinemaUseOf, formatShowTime, zoneShort } from './cinema-model';

const LINK =
  'inline-flex items-center gap-1 rounded-sm text-caption font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Where a film plays from now on: each cinema, its screens with how many shows each, the next
 * show on the cinema's own clock, and - where a state's price order applies - that rule,
 * read-only.
 *
 * Built from the showtimes already loaded and the cinemas' compliance views (one small request
 * per cinema; a film plays at a handful). The rule is explained here and enforced elsewhere:
 * checkout and publishing apply it whether or not this panel renders.
 */
export function WherePlays({
  rows,
  loading,
  now,
  zoneOf,
}: {
  rows: ShowRow[] | undefined;
  loading: boolean;
  /** The page's "now", so this panel agrees with the showtimes about what is upcoming. */
  now: Date;
  zoneOf: (cinemaId: string | null | undefined) => string | undefined;
}) {
  const uses = cinemaUseOf(rows, now);
  const known = uses.filter((u) => u.cinemaId !== 'unknown');
  const rules = useQueries({
    queries: known.map((u) => ({
      queryKey: ['cinema-pricing-compliance', u.cinemaId],
      queryFn: () => api.cinemas.pricingCompliance(u.cinemaId),
      retry: false,
      staleTime: 60_000,
    })),
    combine: (rs) => rs.map((r) => r.data),
  });
  const ruleOf = (cinemaId: string) => rules[known.findIndex((u) => u.cinemaId === cinemaId)];

  return (
    <section
      aria-labelledby="where-plays"
      className="rounded-lg border border-border bg-background-surface p-5 shadow-xs"
    >
      <h2 id="where-plays" className="font-display text-[1.0625rem] font-bold text-text-primary">
        Where it plays
      </h2>
      <p className="mt-0.5 text-caption text-text-muted">Cinemas and screens with upcoming shows</p>
      {loading ? (
        <div className="mt-4 space-y-3" aria-hidden="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : uses.length === 0 ? (
        <p className="mt-4 text-ui text-text-secondary">
          Nothing scheduled yet. Schedule a run to put this film on a screen.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {uses.map((u) => {
            const zone = zoneOf(u.cinemaId);
            const rule = ruleOf(u.cinemaId);
            const regulated = rule && rule.status !== 'NOT_REGULATED';
            return (
              <li key={u.cinemaId} className="space-y-2.5 py-3.5 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-start gap-3">
                  <IconTile icon={Building2} tone="blue" size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-ui font-semibold text-text-primary">
                      {u.cinemaName}
                    </p>
                    <p className="text-caption tabular-nums text-text-muted">
                      {u.shows} upcoming {u.shows === 1 ? 'show' : 'shows'} - next{' '}
                      {formatShowTime(u.next.startsAt, zone)}
                      {zone ? ` ${zoneShort(u.next.startsAt, zone)}` : ''}
                    </p>
                  </div>
                </div>
                <ul
                  className="flex flex-wrap gap-1.5 pl-11"
                  aria-label={`Screens at ${u.cinemaName}`}
                >
                  {u.screens.map((s) => (
                    <li
                      key={s.screenId}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background-subtle px-2 py-1 text-caption text-text-secondary"
                    >
                      <MonitorPlay className="h-3.5 w-3.5 text-text-muted" aria-hidden />
                      <span className="text-text-primary">{s.screenName}</span>
                      <span className="tabular-nums text-text-muted">{s.shows}</span>
                    </li>
                  ))}
                </ul>
                {regulated ? (
                  <p className="flex items-start gap-1.5 pl-11 text-caption text-text-secondary">
                    <Scale
                      className="mt-px h-3.5 w-3.5 shrink-0 text-tile-amber-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0">
                      {rule.maxTicketPriceMinor != null
                        ? `State price limit ${money(rule.maxTicketPriceMinor, 'INR')} per ticket. `
                        : ''}
                      {rule.summary}
                    </span>
                  </p>
                ) : null}
                {u.cinemaId !== 'unknown' ? (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 pl-11">
                    <Link
                      href={`/organizer/cinemas/${u.cinemaId}/schedule`}
                      className={LINK}
                      aria-label={`Schedule at ${u.cinemaName}`}
                    >
                      Schedule <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                    <Link
                      href={`/organizer/cinemas/${u.cinemaId}/readiness`}
                      className={LINK}
                      aria-label={`Readiness of ${u.cinemaName}`}
                    >
                      Readiness <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
