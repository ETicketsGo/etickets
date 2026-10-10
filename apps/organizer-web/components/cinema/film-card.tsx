'use client';

import Link from 'next/link';
import { Archive, CalendarClock, CalendarPlus, FilePen, MapPin, Pencil, Send } from 'lucide-react';
import {
  ButtonLink,
  ImageFrame,
  LifecyclePill,
  Menu,
  ProgressMeter,
  lifecycleOf,
  type MenuItem,
  type Movie,
} from '@eticketsgo/web-kit';
import { SalePill } from './sale-pill';
import {
  formatRuntime,
  formatShowTime,
  zoneShort,
  type FilmProgramme,
  type FilmSale,
} from './cinema-model';

export interface FilmSummary {
  movie: Movie;
  programme: FilmProgramme | null;
  sale: FilmSale | null;
  zoneOf: (cinemaId: string | null | undefined) => string | undefined;
}

type FilmStatus = 'PUBLISHED' | 'ARCHIVED' | 'DRAFT';

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

/**
 * The film's secondary actions. Navigation is a link item, a status change a button item;
 * the status the film is already in is not offered.
 */
export function filmMenuItems(m: Movie, onStatus: (s: FilmStatus) => void): MenuItem[] {
  const base = `/organizer/movies/${m.id}`;
  const status: MenuItem[] = [
    ...(m.status !== 'PUBLISHED'
      ? [{ label: 'Publish film', icon: Send, onSelect: () => onStatus('PUBLISHED') }]
      : []),
    ...(m.status !== 'DRAFT'
      ? [{ label: 'Move to draft', icon: FilePen, onSelect: () => onStatus('DRAFT') }]
      : []),
    ...(m.status !== 'ARCHIVED'
      ? [{ label: 'Archive film', icon: Archive, onSelect: () => onStatus('ARCHIVED') }]
      : []),
  ];
  return [
    { kind: 'link', label: 'Edit details', href: `${base}?tab=details`, icon: Pencil },
    { kind: 'link', label: 'Schedule a run', href: `${base}?schedule=run`, icon: CalendarPlus },
    { kind: 'separator' },
    ...status,
  ];
}

/** The film's lifecycle pill. A film is Draft, Published or (archived) Ended. */
export function FilmLifecycle({ status, size }: { status: string; size?: 'sm' | 'md' }) {
  const l = lifecycleOf(status);
  return l ? <LifecyclePill status={l} size={size} /> : null;
}

function Facts({ f }: { f: FilmSummary }) {
  const p = f.programme;
  if (!p) return <p className="text-caption text-text-muted">Loading showtimes</p>;
  if (p.upcoming === 0)
    return (
      <p className="flex items-center gap-1.5 text-caption text-text-muted">
        <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden />
        No upcoming shows
      </p>
    );
  const zone = p.next ? f.zoneOf(p.next.cinemaId) : undefined;
  return (
    <dl className="min-w-0 space-y-1 text-caption text-text-secondary">
      {p.next ? (
        <div className="flex min-w-0 items-start gap-1.5">
          <dt className="mt-px shrink-0">
            <CalendarClock className="h-3.5 w-3.5 text-text-muted" aria-hidden />
            <span className="sr-only">Next show</span>
          </dt>
          <dd className="min-w-0 tabular-nums">
            Next {formatShowTime(p.next.startsAt, zone)}
            {zone ? (
              <span className="text-text-muted"> {zoneShort(p.next.startsAt, zone)}</span>
            ) : null}
          </dd>
        </div>
      ) : null}
      <div className="flex min-w-0 items-start gap-1.5">
        <dt className="mt-px shrink-0">
          <MapPin className="h-3.5 w-3.5 text-text-muted" aria-hidden />
          <span className="sr-only">Plays at</span>
        </dt>
        <dd className="line-clamp-2 min-w-0 break-words">
          <span className="font-medium tabular-nums text-text-primary">
            {p.upcoming} upcoming {p.upcoming === 1 ? 'show' : 'shows'}
          </span>{' '}
          at {where(p)}
        </dd>
      </div>
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
 * One film in the library grid, in the reference's card language: the poster (2:3, never
 * stretched, the branded placeholder when there is none or the link is broken), the title, its
 * lifecycle and sale state as pills, when and where it plays, a sold meter, and one tinted
 * "Manage" with a square "..." menu beside it.
 *
 * The poster sits to the LEFT rather than on top: a 2:3 poster across a card's full width is
 * a 400px-tall card, and a programmer scans tens of films. The pills sit beside the title
 * rather than over the poster, where a long "Partly selling: ..." would cover the artwork.
 */
export function FilmCard({
  f,
  onStatus,
  priority = false,
}: {
  f: FilmSummary;
  onStatus: (movieId: string, status: FilmStatus) => void;
  priority?: boolean;
}) {
  const m = f.movie;
  const p = f.programme;
  const href = `/organizer/movies/${m.id}`;
  return (
    <article
      aria-labelledby={`film-${m.id}`}
      className="flex min-w-0 flex-col rounded-lg border border-border bg-background-surface p-4 shadow-xs transition-[box-shadow,transform] duration-150 ease-premium hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <div className="flex min-w-0 flex-1 gap-4">
        <Link
          href={href}
          tabIndex={-1}
          aria-hidden="true"
          className="w-[4.5rem] shrink-0 self-start min-[400px]:w-[5.5rem] sm:w-24"
        >
          <ImageFrame
            src={m.posterUrl}
            alt=""
            ratio="2:3"
            category="movie"
            rounded="md"
            priority={priority}
          />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="min-w-0">
            <h2
              id={`film-${m.id}`}
              className="line-clamp-2 break-words font-display text-[1rem] font-bold leading-snug tracking-tight text-text-primary"
            >
              <Link
                href={href}
                className="rounded-sm hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {m.title}
              </Link>
            </h2>
            <p className="mt-0.5 truncate text-caption text-text-muted">{filmFacts(m)}</p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <FilmLifecycle status={m.status} size="sm" />
            {f.sale ? <SalePill verdict={f.sale} size="sm" wrap /> : null}
          </div>
          <Facts f={f} />
          <Exceptions f={f} />
        </div>
      </div>
      {p && p.total > 0 ? (
        <div className="mt-3">
          <ProgressMeter
            value={p.sold}
            max={p.total}
            size="sm"
            label={`Seats sold for ${m.title}, upcoming shows`}
          />
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <ButtonLink href={href} variant="tinted" size="sm" className="flex-1">
          Manage<span className="sr-only"> {m.title}</span>
        </ButtonLink>
        <Menu
          trigger="icon"
          size="sm"
          label={`More actions for ${m.title}`}
          items={filmMenuItems(m, (s) => onStatus(m.id, s))}
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
  onStatus: (movieId: string, status: FilmStatus) => void;
}) {
  const m = f.movie;
  const href = `/organizer/movies/${m.id}`;
  const p = f.programme;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-background-subtle/60 lg:flex-nowrap">
      <div className="w-10 shrink-0">
        <ImageFrame src={m.posterUrl} alt="" ratio="2:3" category="movie" rounded="md" />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <p className="break-words font-semibold text-text-primary">
          <Link
            href={href}
            className="rounded-sm hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {m.title}
          </Link>
        </p>
        <p className="text-caption text-text-muted">{filmFacts(m)}</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 lg:w-72">
        <FilmLifecycle status={m.status} size="sm" />
        {f.sale ? <SalePill verdict={f.sale} size="sm" /> : null}
      </div>
      <div className="min-w-0 basis-full lg:w-40 lg:basis-auto">
        {!p ? (
          <p className="text-caption text-text-muted">Loading</p>
        ) : p.upcoming === 0 ? (
          <p className="text-caption text-text-muted">No upcoming shows</p>
        ) : p.total > 0 ? (
          <ProgressMeter
            value={p.sold}
            max={p.total}
            size="sm"
            label={`Seats sold for ${m.title}`}
          />
        ) : (
          <p className="text-caption tabular-nums text-text-secondary">
            {p.upcoming} upcoming {p.upcoming === 1 ? 'show' : 'shows'}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <ButtonLink href={href} variant="tinted" size="sm">
          Manage<span className="sr-only"> {m.title}</span>
        </ButtonLink>
        <Menu
          trigger="icon"
          size="sm"
          label={`More actions for ${m.title}`}
          items={filmMenuItems(m, (s) => onStatus(m.id, s))}
        />
      </div>
    </li>
  );
}
