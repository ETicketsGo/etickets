'use client';

import { useEffect, useRef } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api, ButtonLink, Skeleton } from '@eticketsgo/web-kit';
import { CircleAlert, CircleCheck, CircleDashed } from 'lucide-react';

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
      className="space-y-4 rounded-lg border border-border bg-background-surface p-4 sm:p-5"
    >
      <div>
        <h2 id="cinema-route-title" className="text-title font-semibold text-text-primary">
          Films are scheduled in Movies
        </h2>
        <p className="mt-1 text-caption text-text-muted">
          Movie screenings use the cinema workflow, so showtimes, screens and seat layouts stay in
          one place. It takes four steps:
        </p>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2">
        {[
          ['Add the film', 'Title, poster, language and certificate.'],
          ['Pick a cinema and screen', 'Your cinema and the screen it plays on.'],
          ['Add showtimes', 'One or many, in the cinema time zone.'],
          ['Check the seat layout', 'Seat categories and their prices.'],
        ].map(([title, line], i) => (
          <li key={title} className="flex gap-3 rounded-md border border-border p-3">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background-subtle text-caption font-semibold tabular-nums text-text-secondary"
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
          <ul className="mt-2 space-y-2">
            {cinemas.map((cinema, i) => {
              const q = readiness[i];
              const sales = q?.data?.sections.find((s) => s.section === 'SALES')?.checks ?? [];
              const blocked = sales.filter((c) => c.level === 'BLOCKED');
              const open = sales.some((c) => c.code === 'SALES_OPEN');
              return (
                <li key={cinema.id} className="flex gap-2 text-sm">
                  {q?.isLoading ? (
                    <CircleDashed aria-hidden="true" className="mt-0.5 h-4 w-4 text-text-muted" />
                  ) : blocked.length > 0 ? (
                    <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 text-status-error" />
                  ) : open ? (
                    <CircleCheck
                      aria-hidden="true"
                      className="mt-0.5 h-4 w-4 text-status-success"
                    />
                  ) : (
                    <CircleDashed aria-hidden="true" className="mt-0.5 h-4 w-4 text-text-muted" />
                  )}
                  <span className="min-w-0">
                    <span className="font-medium text-text-primary">{cinema.name}: </span>
                    <span className="text-text-secondary">
                      {q?.isLoading
                        ? 'Checking...'
                        : q?.isError
                          ? 'Could not check. Open the cinema in Movies to see it.'
                          : blocked.length > 0
                            ? `Not selling: ${blocked.map((b) => b.message).join(' ')}`
                            : open
                              ? 'Selling'
                              : 'No upcoming shows to check yet.'}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <ButtonLink href="/organizer/movies/new">Add a film</ButtonLink>
        <ButtonLink href="/organizer/movies" variant="outline">
          Go to Movies
        </ButtonLink>
      </div>
    </section>
  );
}
