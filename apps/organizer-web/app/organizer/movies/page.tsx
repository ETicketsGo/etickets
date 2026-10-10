'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Film } from 'lucide-react';
import {
  api,
  ButtonLink,
  EmptyState,
  ErrorState,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
  errorMessage,
  useToast,
  type ShowRow,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { FilmCard, FilmRow, type FilmSummary } from '@/components/cinema/film-card';
import { CinemaGlanceStrip } from '@/components/cinema/cinema-glance';
import { useCinemas, useListingSales } from '@/components/cinema/use-cinema-data';
import {
  cinemaSaleVerdict,
  filmSaleSummary,
  filterFilms,
  glanceByCinema,
  languagesOf,
  programmeOf,
} from '@/components/cinema/cinema-model';

const STATUSES = [
  { value: 'PUBLISHED', label: 'Published' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ARCHIVED', label: 'Archived' },
];

type View = 'grid' | 'list';
type FilmStatus = 'PUBLISHED' | 'ARCHIVED' | 'DRAFT';

/**
 * The film library.
 *
 * ── WHY IT IS NOT A TABLE ANY MORE ───────────────────────────────────────────────
 * Owner's verdict on QA (6b80ad8): "this page looks like a basic database table, not a
 * cinema-management experience." It was: title, language, certificate, status - four
 * columns that said nothing about the questions a programmer asks of a film: where is it
 * playing, when is the next show, how full, and can people buy it.
 *
 * So each film now leads with its poster and answers those four questions, and above the
 * library sits what a cinema manager opens the console for: today and the week at each
 * cinema. Every figure is the API's own (show rows, readiness); the sale state is the
 * server's `saleEligibility` answer and is never assumed.
 */
export default function OrganizerMovies() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [language, setLanguage] = useState('');
  const [view, setView] = useState<View>('grid');

  const moviesQ = useQuery({
    queryKey: ['movies', activeOrg.id],
    queryFn: () => api.movies.list(activeOrg.id),
  });
  const cinemas = useCinemas(activeOrg.id);

  /*
    One showtimes request per film. The per-film list is the endpoint that exists for this
    and it carries sold and seat counts; a library is tens of films, not thousands, and each
    answer is cached for the film page that follows.
  */
  const movies = moviesQ.data;
  const showsByFilm = useQueries({
    queries: (movies ?? []).map((m) => ({
      queryKey: ['movie', m.id, 'shows'],
      queryFn: () => api.shows.listForMovie(m.id),
      staleTime: 30_000,
    })),
    combine: (results) => results.map((r) => r.data),
  });
  /*
    "Now" is fixed when the page opens, so every card agrees on what counts as upcoming. The
    sums below are recomputed on each render: a library is tens of films, and memoising on
    query results that are new arrays every render would only add a way to show stale numbers.
  */
  const [now] = useState(() => new Date());
  const allRows = showsByFilm.flatMap((rows) => rows ?? []) as ShowRow[];
  const sales = useListingSales(activeOrg.id, allRows, now);
  const glances = glanceByCinema(allRows, cinemas.zoneOf, now);

  const summaries: FilmSummary[] = (movies ?? []).map((movie, i) => {
    const rows = showsByFilm[i];
    const programme = rows ? programmeOf(rows, now) : null;
    return {
      movie,
      programme,
      sale: programme ? filmSaleSummary(movie, programme, rows, now, sales.listing) : null,
      zoneOf: cinemas.zoneOf,
    };
  });

  /*
    Playing films first, soonest show first; then published films with nothing scheduled,
    then drafts; archived last. A programmer opens the library to work on what is on, not to
    scroll past last year's run.
  */
  const visible = (() => {
    const ids = new Set(filterFilms(movies ?? [], { q, status, language }).map((m) => m.id));
    const rank = (f: FilmSummary) =>
      f.movie.status === 'ARCHIVED'
        ? 3
        : (f.programme?.upcoming ?? 0) > 0
          ? 0
          : f.movie.status === 'PUBLISHED'
            ? 1
            : 2;
    return summaries
      .filter((f) => ids.has(f.movie.id))
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (a.programme?.next?.startsAt ?? '~').localeCompare(b.programme?.next?.startsAt ?? '~') ||
          a.movie.title.localeCompare(b.movie.title),
      );
  })();

  const setFilmStatus = useMutation({
    mutationFn: ({ id, s }: { id: string; s: FilmStatus }) => api.movies.setStatus(id, s),
    onSuccess: (m) => {
      const said =
        m.status === 'PUBLISHED' ? 'published' : m.status === 'ARCHIVED' ? 'archived' : 'a draft';
      toast.push(`${m.title} is now ${said}.`, 'success');
      qc.invalidateQueries({ queryKey: ['movies', activeOrg.id] });
      qc.invalidateQueries({ queryKey: ['movie', m.id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });
  const onStatus = (id: string, s: FilmStatus) => setFilmStatus.mutate({ id, s });

  const languages = useMemo(() => languagesOf(movies ?? []), [movies]);
  const filtering = Boolean(q || status || language);
  const showsLoading = (movies?.length ?? 0) > 0 && showsByFilm.some((r) => r === undefined);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Movies"
        description="Your film library: where each film plays, how it is selling, and what is on this week."
        action={<ButtonLink href="/organizer/movies/new">New movie</ButtonLink>}
      />

      {showsLoading && glances.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <CinemaGlanceStrip
          glances={glances}
          verdictOf={(id) => cinemaSaleVerdict(id, allRows, now, sales.listing)}
        />
      )}

      <section aria-labelledby="library-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="library-heading"
            className="text-title font-semibold tracking-tight text-text-primary"
          >
            Film library
          </h2>
          {movies ? (
            <p className="text-caption tabular-nums text-text-muted" aria-live="polite">
              {filtering
                ? `${visible.length} of ${movies.length} films`
                : `${movies.length} ${movies.length === 1 ? 'film' : 'films'}`}
            </p>
          ) : null}
        </div>

        <div
          role="group"
          aria-label="Filter films"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background-surface p-3"
        >
          <div className="min-w-0 flex-1 basis-56">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Search by title, cast or director"
            />
          </div>
          <div className="w-full sm:w-40">
            <Select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          {languages.length > 1 ? (
            <div className="w-full sm:w-40">
              <Select
                aria-label="Filter by language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="">All languages</option>
                {languages.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <SegmentedControl<View>
            label="Show films as"
            value={view}
            onChange={setView}
            options={[
              { value: 'grid', label: 'Cards' },
              { value: 'list', label: 'List' },
            ]}
          />
        </div>

        {moviesQ.isError ? (
          <ErrorState
            message="We couldn't load your films. Please try again."
            onRetry={() => moviesQ.refetch()}
          />
        ) : moviesQ.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex gap-4 rounded-lg border border-border bg-background-surface p-4"
              >
                <Skeleton className="aspect-[2/3] w-24 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : (movies ?? []).length === 0 ? (
          <EmptyState
            icon={Film}
            title="No films yet"
            hint="Add a film, then schedule it on your screens. Each film shows its poster, its showtimes and how it is selling here."
            action={<ButtonLink href="/organizer/movies/new">New movie</ButtonLink>}
          />
        ) : visible.length === 0 ? (
          <EmptyState title="No films match" hint="Try another search, or clear the filters." />
        ) : view === 'grid' ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((f) => (
              <FilmCard key={f.movie.id} f={f} onStatus={onStatus} />
            ))}
          </div>
        ) : (
          <ul className="overflow-hidden rounded-lg border border-border bg-background-surface">
            {visible.map((f) => (
              <FilmRow key={f.movie.id} f={f} onStatus={onStatus} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
