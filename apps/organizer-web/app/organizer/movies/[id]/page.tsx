'use client';

import Link from 'next/link';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Building2,
  CalendarClock,
  CalendarPlus,
  Clapperboard,
  Clock,
  FilePen,
  Pencil,
  Send,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { ScheduleRunDialog } from '@/components/schedule-run-dialog';
import { instantToWallClock, wallClockToInstant, zoneLabel } from '@/lib/zoned-time';
import { EditShowDialog } from '@/components/edit-show-dialog';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  Button,
  ButtonLink,
  IconTile,
  ImageFrame,
  Menu,
  TabPanel,
  Tabs,
  meterPercent,
  type MenuItem,
  type TileTone,
  Input,
  Select,
  Textarea,
  Dialog,
  Skeleton,
  ErrorState,
  useToast,
  errorMessage,
  type MovieBody,
  type MovieStatusValue,
  type ShowRow,
  type ScheduleShowBody,
  DateTimeField,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { SalePill } from '@/components/cinema/sale-pill';
import { WherePlays } from '@/components/cinema/film-context';
import { ShowCalendar } from '@/components/cinema/show-calendar';
import { Showtimes } from '@/components/cinema/showtimes';
import { ShowQuickLook } from '@/components/cinema/show-quick-look';
import { FilmLifecycle, filmFacts } from '@/components/cinema/film-card';
import { useCinemas, useListingSales } from '@/components/cinema/use-cinema-data';
import {
  filmSaleSummary,
  formatShowTime,
  programmeOf,
  zoneShort,
  type SaleVerdict,
} from '@/components/cinema/cinema-model';

const CERTIFICATES = ['U', 'U/A', 'A', 'S'];
const LANGUAGES = ['Hindi', 'English', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Bengali'];

const splitList = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** A stable empty list, so the listing hook does not see a new array every render. */
const NO_ROWS: ShowRow[] = [];
export default function EditMoviePage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const {
    data: movie,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['movie', id],
    queryFn: () => api.movies.get(id),
  });

  const [form, setForm] = useState({
    title: '',
    synopsis: '',
    runtimeMinutes: '',
    certificate: '',
    language: '',
    genres: '',
    releaseDate: '',
    posterUrl: '',
    trailerUrl: '',
    cast: '',
    director: '',
  });

  useEffect(() => {
    if (movie)
      setForm({
        title: movie.title,
        synopsis: movie.synopsis ?? '',
        runtimeMinutes: String(movie.runtimeMinutes),
        certificate: movie.certificate ?? '',
        language: movie.language,
        genres: movie.genres.join(', '),
        releaseDate: movie.releaseDate ? movie.releaseDate.slice(0, 10) : '',
        posterUrl: movie.posterUrl ?? '',
        trailerUrl: movie.trailerUrl ?? '',
        cast: movie.cast.join(', '),
        director: movie.director ?? '',
      });
  }, [movie]);

  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (form.title.trim().length < 2) e.title = 'Title must be at least 2 characters.';
    if (!form.language.trim()) e.language = 'Language is required.';
    const runtime = Number(form.runtimeMinutes);
    if (!form.runtimeMinutes || !Number.isFinite(runtime) || runtime < 1)
      e.runtimeMinutes = 'Runtime must be at least 1 minute.';
    if (splitList(form.genres).length === 0) e.genres = 'Add at least one genre.';
    return e;
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Partial<MovieBody> = {
        title: form.title.trim(),
        synopsis: form.synopsis.trim() || undefined,
        runtimeMinutes: Number(form.runtimeMinutes),
        certificate: form.certificate || undefined,
        language: form.language.trim(),
        genres: splitList(form.genres),
        releaseDate: form.releaseDate || undefined,
        posterUrl: form.posterUrl.trim() || undefined,
        trailerUrl: form.trailerUrl.trim() || undefined,
        cast: splitList(form.cast),
        director: form.director.trim() || undefined,
      };
      return api.movies.update(id, body);
    },
    onSuccess: () => {
      toast.push('Movie updated.', 'success');
      qc.invalidateQueries({ queryKey: ['movie', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const changeStatus = useMutation({
    mutationFn: (status: MovieStatusValue) => api.movies.setStatus(id, status),
    onSuccess: (updated) => {
      toast.push(`Movie ${updated.status.toLowerCase()}.`, 'success');
      qc.invalidateQueries({ queryKey: ['movie', id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const submit = () => {
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    save.mutate();
  };

  // ---- Shows (scheduling) ----
  const { activeOrg } = useOrg();
  const showsQ = useQuery({
    queryKey: ['movie', id, 'shows'],
    queryFn: () => api.shows.listForMovie(id),
  });
  const cinemasQ = useCinemas(activeOrg.id);

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [sched, setSched] = useState({ cinemaId: '', screenId: '', startsAt: '', endsAt: '' });
  /*
    A showtime is a wall clock AT THE CINEMA. This dialog read "19:00" in the browser's zone,
    so an operator scheduling a Hyderabad screen from Denver stored 19:00 Denver time - found
    on QA in the 2026-10-09 cinema certification. The cinema's zone is authoritative.
  */
  const zoneOfCinema = (cinemaId: string | null | undefined) =>
    cinemasQ.data?.find((c) => c.id === cinemaId)?.timezone ?? undefined;
  const schedZone =
    zoneOfCinema(sched.cinemaId) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [pricing, setPricing] = useState<Record<string, string>>({});
  const [schedError, setSchedError] = useState<string | null>(null);

  const screensQ = useQuery({
    queryKey: ['cinema', sched.cinemaId, 'screens'],
    queryFn: () => api.cinemas.screens(sched.cinemaId),
    enabled: !!sched.cinemaId,
  });
  // A picked screen's seat map exposes categories for optional per-tier pricing.
  const schedMapQ = useQuery({
    queryKey: ['seatmap', sched.screenId],
    queryFn: () => api.shows.getSeatMap(sched.screenId),
    enabled: !!sched.screenId,
  });

  const openSchedule = () => {
    setSched({ cinemaId: '', screenId: '', startsAt: '', endsAt: '' });
    setPricing({});
    setSchedError(null);
    setScheduleOpen(true);
  };

  const schedule = useMutation({
    mutationFn: () => {
      const cats = schedMapQ.data?.categories ?? [];
      const pricingEntries = cats
        .map((c) => ({ seatCategoryId: c.id, raw: pricing[c.id] }))
        .filter((p) => p.raw != null && p.raw !== '')
        .map((p) => ({
          seatCategoryId: p.seatCategoryId,
          priceMinor: Math.round(Number(p.raw) * 100),
        }));
      const body: ScheduleShowBody = {
        screenId: sched.screenId,
        startsAt: wallClockToInstant(sched.startsAt, schedZone).toISOString(),
        endsAt: wallClockToInstant(sched.endsAt, schedZone).toISOString(),
        pricing: pricingEntries.length > 0 ? pricingEntries : undefined,
      };
      return api.shows.schedule(id, body);
    },
    onSuccess: () => {
      toast.push('Show scheduled.', 'success');
      qc.invalidateQueries({ queryKey: ['movie', id, 'shows'] });
      setScheduleOpen(false);
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  /*
    What is actually stopping this dialog from working.

    A brand-new organizer arrives here from the movie page with no cinema and no screen, so
    the Cinema dropdown holds only its placeholder, Screen stays disabled at "Pick a cinema
    first", and submitting said "Pick a screen." — an instruction that cannot be followed
    from this dialog, about a list that is empty for a reason the dialog never mentions.

    So the dialog now names the missing thing and links to where it is created.
  */
  const noCinemas = !cinemasQ.isLoading && (cinemasQ.data ?? []).length === 0;
  const noScreens = !!sched.cinemaId && !screensQ.isLoading && (screensQ.data ?? []).length === 0;
  /*
    The third missing thing, and the one this dialog used to only mutter about.

    A screen with no seat map cannot host a movie show: the API refuses with "The screen has
    no seat map; generate one before scheduling shows." Until now the dialog printed a
    sentence saying so, left the Schedule button ENABLED, and offered no way to fix it — so
    the organizer clicked Schedule, got a server error, and was still stranded, because the
    sentence named "the cinema page" without linking to it.

    That is the same defect the cinema and screen cases already had fixed. Seat maps were
    simply left out of it. Now all three behave identically: name the missing thing, link
    straight to where it is created, and refuse to submit rather than sending somebody into
    an error they cannot act on.
  */
  const noSeatMap = !!sched.screenId && !schedMapQ.isLoading && !schedMapQ.data;
  const cannotSchedule = noCinemas || noScreens || noSeatMap;

  const submitSchedule = () => {
    if (noCinemas) return setSchedError('Create a cinema first — there is nowhere to play this.');
    if (noScreens) return setSchedError('This cinema has no screens yet. Add one first.');
    if (!sched.screenId) return setSchedError('Pick a screen.');
    if (noSeatMap)
      return setSchedError('This screen has no seat map yet — generate one before scheduling.');
    if (!sched.startsAt || !sched.endsAt) return setSchedError('Set start and end times.');
    if (wallClockToInstant(sched.startsAt, schedZone).getTime() < Date.now())
      return setSchedError('Start time must be in the future.');
    if (
      wallClockToInstant(sched.endsAt, schedZone).getTime() <=
      wallClockToInstant(sched.startsAt, schedZone).getTime()
    )
      return setSchedError('End time must be after start time.');
    setSchedError(null);
    schedule.mutate();
  };

  /*
    Editing a show that already exists.

    Reported: "still I don't see edit option for current shows, I see only Move option." That
    was right — `reschedule`, `pricing`, `pause`, `reopen` and `cancel` all existed in the API
    and the console called exactly one of them, so the only tool on the row changed the time
    whether or not that was the problem. One dialog now covers all five.
  */
  const [editing, setEditing] = useState<ShowRow | null>(null);
  const [runOpen, setRunOpen] = useState(false);

  /*
    ── WHAT THE FILM PAGE IS FOR ─────────────────────────────────────────────────────
    Before (QA 6b80ad8) this page opened on a status card and a long form, with the shows in
    a plain table at the bottom - the reverse of how a cinema works. A programmer comes here
    to see when and where the film plays and whether it sells, and edits its synopsis now and
    then. So the showtimes lead, and the details are one tab away, unchanged in what they save.
  */
  const [tab, setTab] = useState<'showtimes' | 'details'>('showtimes');
  const [peek, setPeek] = useState<{ show: ShowRow; verdict: SaleVerdict } | null>(null);
  const [jump, setJump] = useState<{ date: string; at: number } | null>(null);

  // `?tab=details` and `?schedule=run` are what the library's "More" menu links to.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('tab') === 'details') setTab('details');
    if (params.get('schedule') === 'run') setRunOpen(true);
  }, []);

  const [now] = useState(() => new Date());
  const programme = useMemo(() => programmeOf(showsQ.data, now), [showsQ.data, now]);
  const sales = useListingSales(activeOrg.id, showsQ.data ?? NO_ROWS, now);

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !movie)
    return (
      <div className="space-y-6" aria-hidden="true">
        <div className="flex gap-5 rounded-lg border border-border bg-background-surface p-4 sm:p-6">
          <Skeleton className="aspect-[2/3] w-28 rounded-md sm:w-36" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-6 w-1/2" />
          </div>
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );

  const sale = filmSaleSummary(movie, programme, showsQ.data, now, sales.listing);
  const nextZone = programme.next ? cinemasQ.zoneOf(programme.next.cinemaId) : undefined;
  const statusItems: MenuItem[] = [
    ...(movie.status !== 'PUBLISHED'
      ? [{ label: 'Publish film', icon: Send, onSelect: () => changeStatus.mutate('PUBLISHED') }]
      : []),
    ...(movie.status !== 'DRAFT'
      ? [{ label: 'Move to draft', icon: FilePen, onSelect: () => changeStatus.mutate('DRAFT') }]
      : []),
    ...(movie.status !== 'ARCHIVED'
      ? [{ label: 'Archive film', icon: Archive, onSelect: () => changeStatus.mutate('ARCHIVED') }]
      : []),
  ];
  const figure = (v: number | string) => (showsQ.isLoading ? '-' : v);

  return (
    <div className="space-y-6 pb-24 sm:pb-0">
      <nav aria-label="Breadcrumb" className="text-caption text-text-muted">
        <Link
          href="/organizer/movies"
          className="rounded-sm hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Movies
        </Link>
        <span aria-hidden> / </span>
        <span aria-current="page" className="break-words text-text-secondary">
          {movie.title}
        </span>
      </nav>

      {/*
        A grid rather than two flex rows: beside the poster on a tablet and up, the figures sit
        under the title so the card is as tall as the poster and no taller; on a phone the
        poster shrinks beside the title and the figures take the full width below both.
      */}
      <header className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-4 rounded-lg border border-border bg-background-surface p-4 shadow-xs sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-x-6 sm:p-6">
        <div className="sm:row-span-2">
          <ImageFrame
            src={movie.posterUrl}
            alt={`Poster for ${movie.title}`}
            ratio="2:3"
            category="movie"
            rounded="md"
            placeholderLabel="No poster"
            priority
          />
        </div>
        <div className="min-w-0 space-y-3">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 space-y-1.5">
              <p className="text-micro font-semibold uppercase tracking-[0.08em] text-action-primary">
                Film
              </p>
              <h1 className="text-balance break-words font-display text-headline font-bold tracking-tight text-text-primary sm:text-display">
                {movie.title}
              </h1>
              <p className="text-ui text-text-secondary">
                {[filmFacts(movie), movie.genres.join(', ')].filter(Boolean).join(' · ')}
              </p>
            </div>
            {/*
                One primary action. Booking a film in is a RUN (a week, several times a day); a
                single extra showtime and the film's status live in the labelled More menu. An
                organizer with no cinema yet is sent to make one, the only thing that unblocks
                scheduling. On a phone the same controls become a bar fixed to the bottom of the
                screen, where a thumb reaches them; the page leaves room for it below.
              */}
            <div className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-2 border-t border-border bg-background-surface/95 px-4 py-3 shadow-md backdrop-blur sm:static sm:z-auto sm:shrink-0 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none [&>*:first-child]:flex-1 sm:[&>*:first-child]:flex-none">
              {noCinemas ? (
                <ButtonLink href="/organizer/cinemas/new" icon={Building2}>
                  Set up a cinema
                </ButtonLink>
              ) : (
                <Button icon={CalendarPlus} onClick={() => setRunOpen(true)}>
                  Schedule a run
                </Button>
              )}
              <Menu
                ariaLabel={`More actions for ${movie.title}`}
                items={[
                  { label: 'Schedule one show', icon: Clock, onSelect: openSchedule },
                  { label: 'Edit details', icon: Pencil, onSelect: () => setTab('details') },
                  { kind: 'separator' },
                  ...statusItems,
                ]}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <FilmLifecycle status={movie.status} />
            <SalePill verdict={sale} wrap />
          </div>
          {sale.partial && sale.exceptions.length > 0 ? (
            <ul className="space-y-0.5 text-caption text-status-warning">
              {sale.exceptions.map((e) => (
                <li key={e.cinema}>
                  Not selling at {e.cinema}: {e.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {/*
          The film's figures, each from its own show rows: upcoming shows, the cinemas they are
          at, seats sold of seats on sale, and the next show on its cinema's clock.
        */}
        <dl className="col-span-2 grid grid-cols-2 gap-3 self-end border-t border-border pt-4 sm:col-span-1 sm:col-start-2 xl:grid-cols-4">
          <Figure icon={Clapperboard} tone="teal" label="Upcoming shows">
            {figure(programme.upcoming)}
          </Figure>
          <Figure icon={Building2} tone="blue" label="Cinemas">
            {figure(programme.cinemas.length)}
          </Figure>
          <Figure icon={Ticket} tone="purple" label="Seats sold">
            {showsQ.isLoading ? (
              '-'
            ) : (
              <>
                {programme.sold}
                <span className="ml-1 font-sans text-caption font-normal text-text-muted">
                  of {programme.total}
                  {programme.total > 0 ? ` (${meterPercent(programme.sold, programme.total)})` : ''}
                </span>
              </>
            )}
          </Figure>
          <Figure icon={CalendarClock} tone="amber" label="Next show">
            {showsQ.isLoading ? (
              '-'
            ) : programme.next ? (
              <span className="text-[1rem]">
                {formatShowTime(programme.next.startsAt, nextZone)}
                {nextZone ? (
                  <span className="ml-1 font-sans text-caption font-normal text-text-muted">
                    {zoneShort(programme.next.startsAt, nextZone)}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="font-sans text-ui font-normal text-text-muted">None scheduled</span>
            )}
          </Figure>
        </dl>
      </header>

      <Tabs
        id="film"
        label="Film sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'showtimes', label: 'Showtimes', count: showsQ.data?.length },
          { value: 'details', label: 'Details' },
        ]}
      />

      <TabPanel tabsId="film" value="showtimes" selected={tab} className="!pt-0">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          {/*
            The context column: the month at a glance and where the film plays. Beside the list
            on a wide screen; under it on anything narrower, where the list, already grouped
            by day, does the calendar's job and comes first.
          */}
          <div className="order-last min-w-0 xl:order-none xl:col-start-2 xl:row-start-1">
            <div className="space-y-4 xl:sticky xl:top-20">
              <div className="hidden xl:block">
                <ShowCalendar
                  rows={showsQ.data}
                  now={now}
                  zoneOf={cinemasQ.zoneOf}
                  onPickDay={(date) => setJump({ date, at: Date.now() })}
                />
              </div>
              <WherePlays
                rows={showsQ.data}
                loading={showsQ.isLoading}
                now={now}
                zoneOf={cinemasQ.zoneOf}
              />
            </div>
          </div>
          <div className="min-w-0 xl:col-start-1 xl:row-start-1">
            <Showtimes
              rows={showsQ.data}
              loading={showsQ.isLoading}
              error={showsQ.isError}
              onRetry={() => showsQ.refetch()}
              zoneOf={cinemasQ.zoneOf}
              onOpen={(show, verdict) => setPeek({ show, verdict })}
              onEdit={(show) => setEditing(show)}
              onSchedule={() => (noCinemas ? openSchedule() : setRunOpen(true))}
              focus={jump}
            />
          </div>
        </div>
      </TabPanel>
      <TabPanel tabsId="film" value="details" selected={tab} className="!pt-0">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,720px)_minmax(0,1fr)]">
          <section
            aria-labelledby="film-details-heading"
            className="rounded-lg border border-border bg-background-surface p-5 shadow-xs sm:p-6"
          >
            <h2
              id="film-details-heading"
              className="mb-4 font-display text-[1.0625rem] font-bold text-text-primary"
            >
              Film details
            </h2>
            <div className="space-y-4">
              <Input
                id="title"
                label="Title"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                error={fieldErrors.title}
              />
              <Textarea
                id="synopsis"
                label="Synopsis"
                rows={4}
                value={form.synopsis}
                onChange={(e) => set('synopsis', e.target.value)}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  id="runtime"
                  label="Runtime (minutes)"
                  type="number"
                  min={1}
                  value={form.runtimeMinutes}
                  onChange={(e) => set('runtimeMinutes', e.target.value)}
                  error={fieldErrors.runtimeMinutes}
                />
                <Input
                  id="releaseDate"
                  label="Release date"
                  type="date"
                  value={form.releaseDate}
                  onChange={(e) => set('releaseDate', e.target.value)}
                />
                <Select
                  id="language"
                  label="Language"
                  value={form.language}
                  onChange={(e) => set('language', e.target.value)}
                  error={fieldErrors.language}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </Select>
                <Select
                  id="certificate"
                  label="Certificate"
                  value={form.certificate}
                  onChange={(e) => set('certificate', e.target.value)}
                >
                  <option value="">Not set</option>
                  {CERTIFICATES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </div>
              <Input
                id="genres"
                label="Genres"
                hint="Comma-separated, e.g. Action, Thriller"
                value={form.genres}
                onChange={(e) => set('genres', e.target.value)}
                error={fieldErrors.genres}
              />
              <Input
                id="cast"
                label="Cast"
                hint="Comma-separated, e.g. Actor One, Actor Two"
                value={form.cast}
                onChange={(e) => set('cast', e.target.value)}
              />
              <Input
                id="director"
                label="Director"
                value={form.director}
                onChange={(e) => set('director', e.target.value)}
              />
              <Input
                id="posterUrl"
                label="Poster URL"
                value={form.posterUrl}
                onChange={(e) => set('posterUrl', e.target.value)}
              />
              <Input
                id="trailerUrl"
                label="Trailer URL"
                value={form.trailerUrl}
                onChange={(e) => set('trailerUrl', e.target.value)}
              />
              <Button loading={save.isPending} onClick={submit}>
                Save changes
              </Button>
            </div>
          </section>
          {/*
            On a wide screen the empty right half becomes what a buyer will see, updated as the
            operator types: the poster as the storefront lists it, and the line under the title.
          */}
          <aside className="hidden xl:block" aria-label="Preview">
            <div className="sticky top-20 space-y-3 rounded-lg border border-border bg-background-surface p-5 shadow-xs">
              <p className="text-micro font-semibold uppercase tracking-[0.08em] text-text-muted">
                How buyers see it
              </p>
              <div className="flex gap-4">
                <div className="w-28 shrink-0">
                  <ImageFrame
                    src={form.posterUrl || null}
                    alt=""
                    ratio="2:3"
                    category="movie"
                    rounded="md"
                  />
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="break-words font-semibold text-text-primary">
                    {form.title || 'Untitled film'}
                  </p>
                  <p className="text-caption text-text-muted">
                    {[
                      form.language,
                      form.certificate,
                      form.runtimeMinutes ? `${form.runtimeMinutes} min` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <p className="text-caption text-text-secondary">{form.genres}</p>
                </div>
              </div>
              {form.synopsis ? (
                <p className="line-clamp-4 text-caption text-text-secondary">{form.synopsis}</p>
              ) : (
                <p className="text-caption text-text-muted">
                  No synopsis yet. Two or three sentences help buyers choose.
                </p>
              )}
            </div>
          </aside>
        </div>
      </TabPanel>

      <ShowQuickLook
        show={peek?.show ?? null}
        verdict={peek?.verdict ?? null}
        timeZone={cinemasQ.zoneOf(peek?.show.cinemaId)}
        onClose={() => setPeek(null)}
        onEdit={(show) => {
          setPeek(null);
          setEditing(show);
        }}
      />

      <ScheduleRunDialog
        open={runOpen}
        onClose={() => setRunOpen(false)}
        movieId={id}
        cinemas={cinemasQ.data ?? []}
        onScheduled={() => showsQ.refetch()}
      />

      <EditShowDialog
        show={editing}
        onClose={() => setEditing(null)}
        onChanged={() => showsQ.refetch()}
        timeZone={cinemasQ.data?.find((c) => c.id === editing?.cinemaId)?.timezone}
      />

      <Dialog
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        title="Schedule show"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setScheduleOpen(false)}
              disabled={schedule.isPending}
            >
              Cancel
            </Button>
            <Button
              loading={schedule.isPending}
              // Nothing to schedule onto: the button would only ever produce an error.
              disabled={schedule.isPending || cannotSchedule}
              onClick={submitSchedule}
            >
              Schedule
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {noCinemas ? (
            <div className="rounded-md border border-status-warning/30 bg-status-warning/5 p-3">
              {/*
                Says what is and is NOT blocked. Read quickly, "You have no cinemas yet" in a
                warning box looks like the movie failed to save — one organizer reported
                exactly that. The movie is already saved; it is the SHOWTIME that needs
                somewhere to play.
              */}
              <p className="text-caption font-medium text-text-primary">
                Your movie is saved. To put it on sale it needs a cinema.
              </p>
              <p className="mt-1 text-caption text-text-muted">
                A show plays on a screen inside a cinema, so that comes first. It takes a minute,
                and you only do it once — after that this movie and every other one can be scheduled
                on it.
              </p>
              <Link
                href="/organizer/cinemas/new"
                className="mt-2 inline-block text-caption font-medium text-action-primary"
              >
                Create a cinema →
              </Link>
            </div>
          ) : null}

          {noScreens ? (
            <div className="rounded-md border border-status-warning/30 bg-status-warning/5 p-3">
              <p className="text-caption font-medium text-text-primary">
                This cinema has no screens yet.
              </p>
              <p className="mt-1 text-caption text-text-muted">
                Add a screen and publish its seat layout, then this show can be scheduled on it.
              </p>
              <Link
                href={`/organizer/cinemas/${sched.cinemaId}`}
                className="mt-2 inline-block text-caption font-medium text-action-primary"
              >
                Add a screen →
              </Link>
            </div>
          ) : null}

          <Select
            id="schedCinema"
            label="Cinema"
            value={sched.cinemaId}
            onChange={(e) => setSched({ ...sched, cinemaId: e.target.value, screenId: '' })}
          >
            <option value="">
              {cinemasQ.isLoading ? 'Loading…' : noCinemas ? 'No cinemas yet' : 'Select a cinema…'}
            </option>
            {(cinemasQ.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.city}
              </option>
            ))}
          </Select>

          <Select
            id="schedScreen"
            label="Screen"
            value={sched.screenId}
            onChange={(e) => {
              setSched({ ...sched, screenId: e.target.value });
              setPricing({});
            }}
            disabled={!sched.cinemaId || screensQ.isLoading}
          >
            <option value="">
              {!sched.cinemaId
                ? 'Pick a cinema first'
                : screensQ.isLoading
                  ? 'Loading…'
                  : noScreens
                    ? 'No screens in this cinema'
                    : 'Select a screen…'}
            </option>
            {/*
              Readiness on the face of the option.

              Every screen used to look identical here, so an operator picked one by name and
              only discovered it had no seat layout after submitting. Saying it up front turns
              a refusal into a choice.
            */}
            {(screensQ.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.screenType}
                {s.hasSeatMap === false ? ' — no seat map yet' : ''}
              </option>
            ))}
          </Select>

          <div className="grid gap-4 sm:grid-cols-2">
            <DateTimeField
              id="schedStart"
              label="Starts at"
              min={instantToWallClock(new Date(), schedZone)}
              value={sched.startsAt}
              onChange={(v) => setSched({ ...sched, startsAt: v })}
              timeZoneLabel={sched.cinemaId ? `Cinema time: ${zoneLabel(schedZone)}` : undefined}
            />
            <DateTimeField
              id="schedEnd"
              label="Ends at"
              // A film's runtime is the obvious answer here, so the shortcuts offer it
              // relative to the start rather than making anyone add hours in their head.
              relativeTo={sched.startsAt}
              min={sched.startsAt}
              value={sched.endsAt}
              onChange={(v) => setSched({ ...sched, endsAt: v })}
              timeZoneLabel={sched.cinemaId ? `Cinema time: ${zoneLabel(schedZone)}` : undefined}
            />
          </div>

          {sched.screenId &&
            (schedMapQ.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : schedMapQ.data && schedMapQ.data.categories.length > 0 ? (
              <div className="space-y-3 rounded-lg border border-border p-4">
                <p className="text-caption font-medium text-text-secondary">
                  Pricing (optional — leave blank to use seat-map base price)
                </p>
                {schedMapQ.data.categories.map((c) => (
                  <Input
                    key={c.id}
                    id={`price-${c.id}`}
                    label={`${c.name} (₹)`}
                    type="number"
                    min={0}
                    placeholder={String(c.basePriceMinor / 100)}
                    value={pricing[c.id] ?? ''}
                    onChange={(e) => setPricing((p) => ({ ...p, [c.id]: e.target.value }))}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-status-warning/30 bg-status-warning/5 p-3">
                <p className="text-caption font-medium text-text-primary">
                  This screen has no seat map yet.
                </p>
                <p className="mt-1 text-caption text-text-muted">
                  A movie show sells reserved seats, so the screen needs a seat layout before it can
                  host one. Generating it takes a minute and you only do it once per screen.
                </p>
                <Link
                  href={`/organizer/cinemas/${sched.cinemaId}/screens/${sched.screenId}/seatmap`}
                  className="mt-2 inline-block text-caption font-medium text-action-primary"
                >
                  Generate the seat map →
                </Link>
              </div>
            ))}

          {schedError && (
            <p role="alert" className="text-caption text-status-error">
              {schedError}
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}

/** One of the film's figures: a pastel tile, the label and the number. */
function Figure({
  icon,
  tone,
  label,
  children,
}: {
  icon: LucideIcon;
  tone: TileTone;
  label: string;
  children: ReactNode;
}) {
  /*
    The tile sits inside the <dt>, positioned beside the pair: a <dl>'s groups may hold only
    <dt> and <dd>, so a wrapper <div> around them (or a tile beside them) breaks the list for
    a screen reader. The tile is decorative either way.
  */
  return (
    <div className="relative flex min-h-10 min-w-0 flex-col justify-center pl-[3.25rem]">
      <dt className="text-caption text-text-secondary">
        <IconTile icon={icon} tone={tone} className="absolute left-0 top-1/2 -translate-y-1/2" />
        {label}
      </dt>
      <dd className="break-words font-display text-[1.25rem] font-bold leading-tight tabular-nums text-text-primary">
        {children}
      </dd>
    </div>
  );
}
