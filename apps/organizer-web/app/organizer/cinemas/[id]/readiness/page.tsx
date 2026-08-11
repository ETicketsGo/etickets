'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import {
  api,
  Badge,
  Button,
  ButtonLink,
  Card,
  ErrorState,
  MetricCard,
  PageHeader,
  Skeleton,
  errorMessage,
  type PilotReadinessCheck,
} from '@eticketsgo/web-kit';
import {
  checkedAgo,
  headline,
  LEVEL_GLYPH,
  LEVEL_LABEL,
  LEVEL_TONE,
  sectionLabel,
  sortSectionsByUrgency,
  summarise,
} from './readiness-presentation';

/**
 * Launch readiness for one cinema.
 *
 * Answers exactly one question: **what is stopping this cinema from launching?** — and it has
 * to answer it well enough that a theater manager never has to ask engineering.
 *
 * ── THE SERVER DECIDES ────────────────────────────────────────────────────────────
 * Every level, message and fix path in here arrives from `GET /cinemas/:id/pilot-readiness`.
 * This page contains no rules. Re-deriving even one of them locally is how a screen ends up
 * saying READY while the API refuses to activate, and the operator is left with two sources
 * of truth and no way to tell which is lying.
 *
 * ── NOT POLLED ────────────────────────────────────────────────────────────────────
 * Readiness changes when somebody edits configuration, not on a clock. Polling it would burn
 * requests to re-confirm a verdict nobody is changing. It refetches when the tab regains
 * focus — which is exactly the moment an operator comes back from fixing something — and on
 * demand.
 */
export default function LaunchReadinessPage() {
  const { id: cinemaId } = useParams<{ id: string }>();

  const readinessQ = useQuery({
    queryKey: ['cinema', cinemaId, 'pilot-readiness'],
    queryFn: () => api.cinemas.pilotReadiness(cinemaId),
    // Coming back from a fix is the moment the answer changes, so re-ask then. `staleTime: 0`
    // means the operator never reads a cached verdict from before their own edit.
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    staleTime: 0,
  });

  const report = readinessQ.data;
  const summary = report ? summarise(report) : null;
  const now = new Date();

  return (
    <div className="space-y-6">
      <PageHeader
        title={report ? `${report.cinemaName} — launch readiness` : 'Launch readiness'}
        description="What is configured, what needs review, and what is stopping this cinema opening."
        breadcrumbs={[
          { label: 'Cinemas', href: '/organizer/cinemas' },
          { label: 'Launch readiness' },
        ]}
        action={
          <Button
            variant="secondary"
            loading={readinessQ.isFetching}
            onClick={() => void readinessQ.refetch()}
          >
            Re-check
          </Button>
        }
      />

      {readinessQ.isPending ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : readinessQ.isError ? (
        <ErrorState
          message={errorMessage(readinessQ.error)}
          onRetry={() => void readinessQ.refetch()}
        />
      ) : report && summary ? (
        <>
          {/*
            role=status so the verdict is announced when it changes — an operator who fixes a
            blocker and re-checks should hear the result, not have to hunt for it.
          */}
          <Card>
            <div className="space-y-4" role="status" aria-live="polite">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={LEVEL_TONE[summary.overall]}>
                  <span aria-hidden>{LEVEL_GLYPH[summary.overall]} </span>
                  {LEVEL_LABEL[summary.overall]}
                </Badge>
                <p className="text-sm font-medium">{headline(summary)}</p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <MetricCard label="Ready" value={String(summary.ready)} />
                <MetricCard label="Needs review" value={String(summary.warnings)} />
                <MetricCard label="Blocking" value={String(summary.blockers)} />
              </div>

              <p className="text-caption text-text-muted">
                Local times are reckoned in {report.timezone}. Checked{' '}
                {checkedAgo(report.evaluatedAt, now)}.
              </p>
            </div>
          </Card>

          {/*
            Blocking sections first. A checklist that lists twelve green sections above the one
            red one is a checklist nobody reads to the bottom of.
          */}
          {sortSectionsByUrgency(report.sections).map((section) => (
            <Card key={section.section}>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <h2 className="text-title font-semibold">{sectionLabel(section.section)}</h2>
                <Badge tone={LEVEL_TONE[section.level]}>
                  <span aria-hidden>{LEVEL_GLYPH[section.level]} </span>
                  {LEVEL_LABEL[section.level]}
                </Badge>
              </div>

              <ul className="space-y-3">
                {section.checks.map((check) => (
                  <CheckRow key={check.code} check={check} />
                ))}
              </ul>
            </Card>
          ))}
        </>
      ) : null}
    </div>
  );
}

/**
 * One readiness check.
 *
 * The message is the SERVER's words. Rewriting it here would mean two places to keep accurate,
 * and the server is the one that knows why it refused.
 */
function CheckRow({ check }: { check: PilotReadinessCheck }) {
  return (
    <li
      className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-border/50 pb-3 last:border-0 last:pb-0"
      data-testid={`check-${check.code}`}
      data-level={check.level}
    >
      {/*
        The level is written out, not signalled by colour. `sr-only` rather than aria-label on
        the badge so it is announced once, in reading order, alongside the message.
      */}
      <Badge tone={LEVEL_TONE[check.level]}>
        <span aria-hidden>{LEVEL_GLYPH[check.level]} </span>
        {LEVEL_LABEL[check.level]}
      </Badge>

      <p className="min-w-[14rem] flex-1 text-sm">{check.message}</p>

      {check.fixPath ? (
        <ButtonLink href={check.fixPath} variant="outline" size="sm">
          {check.level === 'READY' ? 'Review' : 'Fix this'}
        </ButtonLink>
      ) : null}
    </li>
  );
}
