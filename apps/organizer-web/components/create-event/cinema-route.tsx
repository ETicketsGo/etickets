'use client';

import { useEffect, useRef } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  api,
  ButtonLink,
  SellingPill,
  Skeleton,
  StatusPill,
  tileClasses,
} from '@eticketsgo/web-kit';
import { ArrowRight, Clapperboard } from 'lucide-react';
import { ExperienceArt } from './experience-art';

/** How many cinemas are asked about. Each answer is one request; an operator with more uses Movies. */
const MAX_CINEMAS = 6;

/**
 * Where a film goes instead of this flow, and whether its cinemas can sell.
 *
 * ── WHY THIS DOES NOT SCHEDULE THE FILM ITSELF ─────────────────────────────────────
 * Films are scheduled through the cinema workflow: the film, then a cinema and a screen, then
 * showtimes on that screen's seat layout, priced under the cinema's regulated pricing rules.
 * A second way in from here would be a second copy of those rules. So this explains the steps
 * and sends the organizer to the real flow.
 *
 * ── WHY IT SAYS WHETHER CINEMAS CAN SELL ───────────────────────────────────────────
 * Some markets do not allow online cinema sales yet (a state with no cinema pricing policy, for
 * one). Finding that out after scheduling a week of shows is the worst time. The answer is the
 * server's own: each cinema's readiness report asks the same sale-eligibility question checkout
 * asks, and its "Online sales" checks are shown here word for word. Nothing is judged in the
 * browser.
 */
export function CinemaRoute({ organizationId }: { organizationId: string }) {
  const cinemasQ = useQuery({
    queryKey: ['cinemas', organizationId],
    queryFn: () => api.cinemas.list(organizationId),
  });
  const cinemas = (cinemasQ.data ?? []).slice(0, MAX_CINEMAS);
  const readiness = useQueries({
    queries: cinemas.map((c) => ({
      queryKey: ['cinema-pilot-readiness', c.id],
      queryFn: () => api.cinemas.pilotReadiness(c.id),
    })),
  });

  /*
    Brought into view when the film is chosen: on a phone it sits under all seven cards, and a
    choice whose answer is off screen looks like a choice that did nothing.
  */
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ref.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, []);

  return (
    <section
      ref={ref}
      aria-labelledby="cinema-route-title"
      className="space-y-5 overflow-hidden rounded-lg border border-border bg-background-surface p-4 shadow-xs sm:p-6"
    >
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className={`relative hidden h-16 w-28 shrink-0 overflow-hidden rounded-md sm:block ${tileClasses('blue')}`}
        >
          <ExperienceArt id="movie" className="absolute inset-0 h-full w-full" />
        </span>
        <div>
          <h2
            id="cinema-route-title"
            className="flex items-center gap-2 font-display text-title font-bold text-text-primary"
          >
            <Clapperboard aria-hidden="true" className="h-5 w-5 text-text-muted sm:hidden" />
            Films are scheduled in Movies
          </h2>
          <p className="mt-1 text-caption text-text-secondary">
            Movie screenings use the cinema workflow, so showtimes, screens and seat layouts stay in
            one place. It takes four steps:
          </p>
        </div>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2">
        {[
          ['Add the film', 'Title, poster, language and certificate.'],
          ['Pick a cinema and screen', 'Your cinema and the screen it plays on.'],
          ['Add showtimes', 'One or many, in the cinema time zone.'],
          ['Check the seat layout', 'Seat categories and their prices.'],
        ].map(([title, line], i) => (
          <li key={title} className="flex gap-3 rounded-lg border border-border p-3">
            <span
              aria-hidden="true"
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-caption font-bold tabular-nums ${tileClasses('blue')}`}
            >
              {i + 1}
            </span>
            <span className="text-sm">
              <span className="block font-medium text-text-primary">{title}</span>
              <span className="block text-caption text-text-muted">{line}</span>
            </span>
          </li>
        ))}
      </ol>

      <div aria-live="polite">
        <h3 className="text-sm font-semibold text-text-primary">Online sales at your cinemas</h3>
        {cinemasQ.isLoading ? (
          <Skeleton className="mt-2 h-10 w-full" />
        ) : cinemasQ.isError ? (
          <p className="mt-1 text-caption text-text-muted">
            We could not check your cinemas just now. Movies shows it for each cinema.
          </p>
        ) : cinemas.length === 0 ? (
          <p className="mt-1 text-caption text-text-muted">
            You have no cinema yet. Add one in Movies; we then check whether online cinema sales are
            allowed where it is, before you schedule anything.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {cinemas.map((cinema, i) => {
              const q = readiness[i];
              const sales = q?.data?.sections.find((s) => s.section === 'SALES')?.checks ?? [];
              const blocked = sales.filter((c) => c.level === 'BLOCKED');
              const open = sales.some((c) => c.code === 'SALES_OPEN');
              /*
                The server's words, in the console's selling vocabulary. "Selling" only when the
                cinema's own report says sales are open and nothing blocks them.
              */
              return (
                <li
                  key={cinema.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm"
                >
                  <span className="min-w-0 break-words font-medium text-text-primary">
                    {cinema.name}
                  </span>
                  {q?.isLoading ? (
                    <StatusPill tone="neutral" size="sm">
                      Checking...
                    </StatusPill>
                  ) : q?.isError ? (
                    <span className="text-caption text-text-muted">
                      Could not check. Open the cinema in Movies to see it.
                    </span>
                  ) : blocked.length > 0 ? (
                    <SellingPill
                      state="not"
                      reason={blocked.map((b) => b.message).join(' ')}
                      size="sm"
                    />
                  ) : open ? (
                    <SellingPill state="selling" size="sm" />
                  ) : (
                    <StatusPill tone="neutral" size="sm">
                      No upcoming shows to check yet
                    </StatusPill>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <ButtonLink href="/organizer/movies/new">
          Add a film <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </ButtonLink>
        <ButtonLink href="/organizer/movies" variant="outline">
          Go to Movies
        </ButtonLink>
      </div>
    </section>
  );
}
