'use client';

import Link from 'next/link';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  api,
  Button,
  Card,
  Input,
  Select,
  Textarea,
  Dialog,
  DataTable,
  Skeleton,
  ErrorState,
  PageHeader,
  StatusBadge,
  useToast,
  errorMessage,
  dateTime,
  type Column,
  type MovieBody,
  type MovieStatusValue,
  type ShowRow,
  type ScheduleShowBody,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

const CERTIFICATES = ['U', 'U/A', 'A', 'S'];
const LANGUAGES = ['Hindi', 'English', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Bengali'];

const splitList = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// `datetime-local` inputs expect a local `YYYY-MM-DDTHH:mm` string.
const localDateTimeValue = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

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
  const cinemasQ = useQuery({
    queryKey: ['cinemas', activeOrg.id],
    queryFn: () => api.cinemas.list(activeOrg.id),
  });

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [sched, setSched] = useState({ cinemaId: '', screenId: '', startsAt: '', endsAt: '' });
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
        startsAt: new Date(sched.startsAt).toISOString(),
        endsAt: new Date(sched.endsAt).toISOString(),
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
    if (new Date(sched.startsAt).getTime() < Date.now())
      return setSchedError('Start time must be in the future.');
    if (new Date(sched.endsAt) <= new Date(sched.startsAt))
      return setSchedError('End time must be after start time.');
    setSchedError(null);
    schedule.mutate();
  };

  const showColumns: Column<ShowRow>[] = [
    { key: 'startsAt', header: 'Showtime', render: (s) => dateTime(s.startsAt) },
    { key: 'screenName', header: 'Screen', render: (s) => s.screenName ?? '—' },
    { key: 'cinemaName', header: 'Cinema', render: (s) => s.cinemaName ?? '—' },
    {
      key: 'seats',
      header: 'Seats sold',
      render: (s) => `${s.seatsSold} / ${s.seatsTotal}`,
    },
  ];

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  if (isLoading || !movie) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={movie.title}
        breadcrumbs={[{ label: 'Movies', href: '/organizer/movies' }, { label: movie.title }]}
        action={<StatusBadge status={movie.status} />}
      />

      <Card title="Status">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={movie.status} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              loading={changeStatus.isPending}
              disabled={movie.status === 'PUBLISHED'}
              onClick={() => changeStatus.mutate('PUBLISHED')}
            >
              Publish
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={changeStatus.isPending}
              disabled={movie.status === 'ARCHIVED'}
              onClick={() => changeStatus.mutate('ARCHIVED')}
            >
              Archive
            </Button>
            {movie.status !== 'DRAFT' && (
              <Button
                variant="ghost"
                size="sm"
                loading={changeStatus.isPending}
                onClick={() => changeStatus.mutate('DRAFT')}
              >
                Move to draft
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card title="Details">
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
      </Card>

      <Card
        title="Shows"
        action={
          <Button size="sm" onClick={openSchedule}>
            Schedule show
          </Button>
        }
      >
        <DataTable
          columns={showColumns}
          rows={showsQ.data}
          loading={showsQ.isLoading}
          error={showsQ.isError ? "We couldn't load shows. Please try again." : undefined}
          onRetry={() => showsQ.refetch()}
          rowKey={(s) => s.sessionId}
          empty={
            <div className="p-8 text-center text-text-muted">
              No shows scheduled yet. Schedule a show to start selling seats.
            </div>
          }
        />
      </Card>

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
            {(screensQ.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.screenType}
              </option>
            ))}
          </Select>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="schedStart"
              label="Starts at"
              type="datetime-local"
              min={localDateTimeValue(new Date())}
              value={sched.startsAt}
              onChange={(e) => setSched({ ...sched, startsAt: e.target.value })}
            />
            <Input
              id="schedEnd"
              label="Ends at"
              type="datetime-local"
              value={sched.endsAt}
              onChange={(e) => setSched({ ...sched, endsAt: e.target.value })}
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
