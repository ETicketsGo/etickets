'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import {
  api,
  Badge,
  ButtonLink,
  Card,
  ErrorState,
  PageHeader,
  Skeleton,
  errorMessage,
} from '@eticketsgo/web-kit';
import {
  LEVEL_GLYPH,
  LEVEL_TONE,
  onboardingSteps,
  sectionLabel,
  STEP_STATE_LABEL,
  stepLevel,
  summarise,
} from '../readiness/readiness-presentation';

/**
 * Guided setup for a new cinema.
 *
 * ── THIS IS A SHELL, NOT A SECOND PRODUCT ─────────────────────────────────────────
 * Every step links to the screen where the work is actually done — the cinema form, the seat
 * layout designer, the scheduling workspace. Rebuilding any of those inside a wizard would
 * create a second place to keep correct, and the two would drift.
 *
 * ── PROGRESS IS DERIVED, NEVER STORED ─────────────────────────────────────────────
 * There is no onboarding-progress table and no wizard checkbox. Each step's state comes from
 * the live readiness verdict, so leaving and coming back always shows the truth. A stored
 * "complete" flag can disagree with reality — a screen taken out of service, a layout
 * archived — and a wizard reporting complete over a cinema that cannot sell a ticket is worse
 * than no wizard at all.
 *
 * The cost is honest: a step can go back from Complete to Blocked if somebody changes
 * configuration. That is the point.
 */
export default function CinemaOnboardingPage() {
  const { id: cinemaId } = useParams<{ id: string }>();

  const cinemaQ = useQuery({
    queryKey: ['cinema', cinemaId],
    queryFn: () => api.cinemas.get(cinemaId),
  });

  const readinessQ = useQuery({
    queryKey: ['cinema', cinemaId, 'pilot-readiness'],
    queryFn: () => api.cinemas.pilotReadiness(cinemaId),
    // Same contract as the readiness page: re-ask when the operator returns from doing work.
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    staleTime: 0,
  });

  const report = readinessQ.data;
  const steps = onboardingSteps(cinemaId);
  const summary = report ? summarise(report) : null;
  const done = report ? steps.filter((s) => stepLevel(s, report) === 'READY').length : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={cinemaQ.data ? `Set up ${cinemaQ.data.name}` : 'Set up this cinema'}
        description="Work through these in any order. Progress reflects your live configuration, not a saved checklist."
        breadcrumbs={[
          { label: 'Rooms & seat maps', href: '/organizer/cinemas' },
          { label: 'Setup' },
        ]}
        action={
          <ButtonLink href={`/organizer/cinemas/${cinemaId}/readiness`} variant="secondary">
            Launch readiness
          </ButtonLink>
        }
      />

      {readinessQ.isPending ? (
        <Skeleton className="h-96 w-full" aria-busy="true" />
      ) : readinessQ.isError ? (
        <ErrorState
          message={errorMessage(readinessQ.error)}
          onRetry={() => void readinessQ.refetch()}
        />
      ) : (
        <>
          <Card>
            <p className="text-sm" role="status" aria-live="polite">
              <span className="font-medium">
                {done} of {steps.length} steps complete.
              </span>{' '}
              {summary?.overall === 'BLOCKED'
                ? `${summary.blockers} thing${summary.blockers === 1 ? '' : 's'} must be fixed before this cinema can open.`
                : summary?.overall === 'WARNING'
                  ? 'This cinema can open, with some items worth reviewing.'
                  : 'This cinema is ready to open.'}
            </p>
          </Card>

          <ol className="space-y-3">
            {steps.map((step, index) => {
              const level = stepLevel(step, report);
              return (
                <li key={step.label}>
                  <Card>
                    <div
                      className="flex flex-wrap items-center gap-x-4 gap-y-2"
                      data-testid={`step-${step.section ?? 'REVIEW'}`}
                      data-level={level}
                    >
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-background-subtle text-caption font-semibold tabular-nums"
                        aria-hidden
                      >
                        {index + 1}
                      </span>

                      <span className="min-w-[8rem] flex-1 font-medium">{step.label}</span>

                      {/* State in words and a glyph, never colour alone. */}
                      {level === 'UNKNOWN' ? (
                        <Badge tone="neutral">{STEP_STATE_LABEL.UNKNOWN}</Badge>
                      ) : (
                        <Badge tone={LEVEL_TONE[level]}>
                          <span aria-hidden>{LEVEL_GLYPH[level]} </span>
                          {STEP_STATE_LABEL[level]}
                        </Badge>
                      )}

                      {step.path ? (
                        <ButtonLink
                          href={step.path}
                          variant={level === 'BLOCKED' ? 'primary' : 'outline'}
                          size="sm"
                          aria-label={`Open ${step.label} setup`}
                        >
                          {level === 'READY' ? 'Review' : 'Set up'}
                        </ButtonLink>
                      ) : (
                        /*
                          No destination, so say why rather than linking nowhere. An operator
                          told "configure pricing" with no way to do it is worse off than one
                          told the screen does not exist yet and who to ask.
                        */
                        <Badge tone="neutral">No self-service screen yet</Badge>
                      )}
                    </div>

                    {step.gap ? (
                      <p className="mt-2 text-caption text-text-muted">{step.gap}</p>
                    ) : null}

                    {/* The server's own words about what is wrong with this step. */}
                    {report && step.section
                      ? report.sections
                          .find((s) => s.section === step.section)
                          ?.checks.filter((c) => c.level !== 'READY')
                          .map((c) => (
                            <p key={c.code} className="mt-2 text-caption text-text-secondary">
                              {sectionLabel(step.section as string)}: {c.message}
                            </p>
                          ))
                      : null}
                  </Card>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
