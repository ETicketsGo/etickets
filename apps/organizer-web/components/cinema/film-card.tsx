'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock, MapPin } from 'lucide-react';
import { Badge, Meter, type Movie } from '@eticketsgo/web-kit';
import { FilmPoster } from './film-poster';
import { SaleChip } from './sale-chip';
import { MoreMenu } from './more-menu';
import {
  filmStatusLabel,
  formatRuntime,
  formatShowTime,
  percentSold,
  type FilmProgramme,
  type FilmSale,
} from './cinema-model';

export interface FilmSummary {
  movie: Movie;
  programme: FilmProgramme | null;
  sale: FilmSale | null;
  zoneOf: (cinemaId: string | null | undefined) => string | undefined;
}

/** "Telugu · UA · 2h 18m": what a cinema prints under a title. */
export function filmFacts(m: Movie): string {
  return [m.language, m.certificate, formatRuntime(m.runtimeMinutes)].filter(Boolean).join(' · ');
}

/** "3 cinemas" or the one cinema's name. */
function where(p: FilmProgramme): string {
  if (p.cinemas.length === 1) return p.cinemas[0]!.name;
  const [first, ...rest] = p.cinemas;
  return `${first!.name} and ${rest.length} more ${rest.length === 1 ? 'cinema' : 'cinemas'}`;
}

/** The secondary actions for one film. */
function filmMenu(
  m: Movie,
  router: ReturnType<typeof useRouter>,
  onStatus: (s: 'PUBLISHED' | 'ARCHIVED' | 'DRAFT') => void,
) {
  const base = `/organizer/movies/${m.id}`;
  return [
    { label: 'Edit details', onSelect: () => router.push(`${base}?tab=details`) },
    { label: 'Schedule a run', onSelect: () => router.push(`${base}?schedule=run`) },
    ...(m.status !== 'PUBLISHED'
      ? [{ label: 'Publish film', onSelect: () => onStatus('PUBLISHED') }]
      : []),
    ...(m.status !== 'DRAFT'
      ? [{ label: 'Move to draft', onSelect: () => onStatus('DRAFT') }]
      : []),
    ...(m.status !== 'ARCHIVED'
      ? [{ label: 'Archive film', onSelect: () => onStatus('ARCHIVED') }]
      : []),
  ];
}

function Programme({ f }: { f: FilmSummary }) {
  const p = f.programme;
  if (!p) return <p className="text-caption text-text-muted">Loading showtimes</p>;
  if (p.upcoming === 0) return <p className="text-[0.875rem] text-text-muted">No upcoming shows</p>;
  const pct = percentSold(p.sold, p.total);
  return (
    <dl className="min-w-0 space-y-1.5 text-[0.875rem] text-text-secondary">
      <div className="flex min-w-0 items-start gap-2">
        <dt className="mt-0.5 shrink-0">
          <MapPin className="h-4 w-4 text-text-muted" aria-hidden />
          <span className="sr-only">Plays at</span>
        </dt>
        <dd className="min-w-0 break-words">
          <span className="font-medium tabular-nums text-text-primary">
            {p.upcoming} upcoming {p.upcoming === 1 ? 'show' : 'shows'}
          </span>{' '}
          at {where(p)}
        </dd>
      </div>
      {p.next ? (
        <div className="flex min-w-0 items-start gap-2">
          <dt className="mt-0.5 shrink-0">
            <CalendarClock className="h-4 w-4 text-text-muted" aria-hidden />
            <span className="sr-only">Next show</span>
          </dt>
          <dd className="min-w-0 break-words">
            Next{' '}
            <span className="tabular-nums">
              {formatShowTime(p.next.startsAt, f.zoneOf(p.next.cinemaId))}
            </span>
          </dd>
        </div>
      ) : null}
      {p.total > 0 ? (
        <div className="space-y-1 pt-0.5">
          <dt className="sr-only">Seats sold</dt>
          <dd className="text-caption tabular-nums">
            {p.sold} of {p.total} seats sold{pct !== null ? ` (${pct}%)` : ''}
          </dd>
          <dd>
            <Meter value={p.sold} max={p.total} label={`Seats sold for ${f.movie.title}`} />
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function Exceptions({ f }: { f: FilmSummary }) {
  if (!f.sale || f.sale.exceptions.length === 0 || !f.sale.partial) return null;
  return (
    <ul className="space-y-0.5 text-caption text-status-warning">
      {f.sale.exceptions.map((e) => (
        <li key={e.cinema} className="break-words">
          Not selling at {e.cinema}: {e.reason}
        </li>
      ))}
    </ul>
  );
}

/**
 * One film in the library grid: poster first, then what it is, where it plays and whether it
 * sells. One worded "Manage" and a labelled "More" menu, never a row of icons.
 */
export function FilmCard({
  f,
  onStatus,
}: {
  f: FilmSummary;
  onStatus: (movieId: string, status: 'PUBLISHED' | 'ARCHIVED' | 'DRAFT') => void;
}) {
  const router = useRouter();
  const m = f.movie;
  const status = filmStatusLabel(m.status);
  const href = `/organizer/movies/${m.id}`;
  return (
    <article
      aria-labelledby={`film-${m.id}`}
      className="group flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-background-surface p-4 transition-[box-shadow,transform] duration-150 ease-premium hover:-translate-y-px hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <div className="flex min-w-0 flex-1 gap-4">
        <Link href={href} tabIndex={-1} aria-hidden="true" className="w-24 shrink-0 sm:w-28">
          <FilmPoster posterUrl={m.posterUrl} />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="min-w-0 space-y-1">
            <h2
              id={`film-${m.id}`}
              className="line-clamp-2 break-words text-[1rem] font-semibold leading-snug tracking-tight text-text-primary"
            >
              <Link
                href={href}
                className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {m.title}
              </Link>
            </h2>
            <p className="text-caption text-text-muted">{filmFacts(m)}</p>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <Badge tone={status.tone === 'success' ? 'success' : 'neutral'}>
                <span className="sr-only">Film status: </span>
                {status.label}
              </Badge>
              {f.sale ? <SaleChip verdict={f.sale} /> : null}
            </div>
          </div>
          <Programme f={f} />
          <Exceptions f={f} />
        </div>
      </div>
      {/* Across the whole card, so the two buttons sit side by side even in a narrow column. */}
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Link
          href={href}
          aria-label={`Manage ${m.title}`}
          className="inline-flex h-9 items-center rounded-md bg-action-primary px-3.5 text-button font-semibold text-action-primary-foreground transition-colors hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas active:translate-y-px"
        >
          Manage
        </Link>
        <MoreMenu
          accessibleLabel={`More actions for ${m.title}`}
          align="left"
          items={filmMenu(m, router, (s) => onStatus(m.id, s))}
        />
      </div>
    </article>
  );
}

/** The same film as one compact row, for the list view. */
export function FilmRow({
  f,
  onStatus,
}: {
  f: FilmSummary;
  onStatus: (movieId: string, status: 'PUBLISHED' | 'ARCHIVED' | 'DRAFT') => void;
}) {
  const router = useRouter();
  const m = f.movie;
  const status = filmStatusLabel(m.status);
  const href = `/organizer/movies/${m.id}`;
  const p = f.programme;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:flex-nowrap">
      <div className="w-10 shrink-0">
        <FilmPoster posterUrl={m.posterUrl} iconClassName="h-4 w-4" compact />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <p className="break-words font-semibold text-text-primary">
          <Link
            href={href}
            className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {m.title}
          </Link>
        </p>
        <p className="text-caption text-text-muted">{filmFacts(m)}</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:w-64">
        <Badge tone={status.tone === 'success' ? 'success' : 'neutral'}>
          <span className="sr-only">Film status: </span>
          {status.label}
        </Badge>
        {f.sale ? <SaleChip verdict={f.sale} /> : null}
      </div>
      <p className="min-w-0 text-caption tabular-nums text-text-secondary sm:w-44">
        {!p
          ? 'Loading'
          : p.upcoming === 0
            ? 'No upcoming shows'
            : `${p.upcoming} upcoming at ${p.cinemas.length} ${p.cinemas.length === 1 ? 'cinema' : 'cinemas'}`}
      </p>
      <div className="flex items-center gap-2">
        <Link
          href={href}
          aria-label={`Manage ${m.title}`}
          className="inline-flex h-9 items-center rounded-md border border-border-input bg-background-surface px-3 text-button font-medium text-text-primary hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Manage
        </Link>
        <MoreMenu
          accessibleLabel={`More actions for ${m.title}`}
          items={filmMenu(m, router, (s) => onStatus(m.id, s))}
        />
      </div>
    </li>
  );
}
