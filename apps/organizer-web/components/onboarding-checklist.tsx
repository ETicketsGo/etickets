'use client';

import Link from 'next/link';
import { CheckCircle2, Circle, ArrowRight, X, Rocket } from 'lucide-react';
import { ButtonLink, Card, ErrorState, Skeleton } from '@eticketsgo/web-kit';
import {
  setOnboardingDismissed,
  useOnboardingDismissed,
  useOnboardingProgress,
  type OnboardingProgress,
} from '@/lib/onboarding';

/** Accessible progress bar built from design tokens (not a new web-kit primitive). */
function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-caption text-text-muted">
        <span>
          {completed} of {total} complete
        </span>
        <span>{pct}%</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-background-subtle"
        role="progressbar"
        aria-valuenow={completed}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`Onboarding progress: ${completed} of ${total} complete`}
      >
        <div
          className="h-full rounded-full bg-action-primary transition-all duration-500 ease-premium"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Full checklist (progress + step list with links). Rendered on the onboarding page.
 * `progress` is passed in so the page and this list share one set of queries.
 */
export function OnboardingChecklist({ progress }: { progress: OnboardingProgress }) {
  const { steps, completed, total, isLoading, isError, refetch } = progress;

  if (isError) {
    return (
      <ErrorState message="We couldn't load your progress. Please try again." onRetry={refetch} />
    );
  }

  return (
    <Card title="Your setup progress">
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-2 w-full" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <ProgressBar completed={completed} total={total} />
          <ul className="divide-y divide-border">
            {steps.map((s) => (
              <li key={s.key} className="flex items-center gap-3 py-3">
                {s.done ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-status-success" aria-hidden />
                ) : (
                  <Circle className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p
                    className={`font-medium ${s.done ? 'text-text-muted line-through' : 'text-text-primary'}`}
                  >
                    {s.title}
                  </p>
                  <p className="truncate text-caption text-text-muted">{s.description}</p>
                </div>
                <Link
                  href={s.href}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-caption font-semibold text-action-primary transition-colors hover:bg-tint-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {s.cta}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/**
 * Dismissible welcome card for the dashboard. Hidden once every step is complete or
 * the organizer dismisses it (persisted in localStorage via `etg_onboarding_done`).
 */
export function WelcomeCard({ orgId, orgName }: { orgId: string; orgName: string }) {
  const dismissed = useOnboardingDismissed();
  const progress = useOnboardingProgress(orgId, orgName);
  const { completed, total, allComplete, isLoading, isError } = progress;

  // Nothing useful to show, or the organizer is done / has opted out.
  if (dismissed || isError) return null;
  if (!isLoading && allComplete) return null;

  return (
    <Card className="border-action-primary/30 bg-action-primary/[0.04]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tint-primary text-action-primary">
            <Rocket className="h-5 w-5" />
          </span>
          <div>
            <p className="font-semibold text-text-primary">Finish setting up your account</p>
            <p className="mt-0.5 text-[0.9375rem] text-text-muted">
              A few quick steps to start selling tickets.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOnboardingDismissed(true)}
          aria-label="Dismiss onboarding"
          className="rounded-full p-1.5 text-text-muted transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <Skeleton className="h-2 w-full" />
        ) : (
          <ProgressBar completed={completed} total={total} />
        )}
      </div>

      <div className="mt-4">
        <ButtonLink href="/organizer/onboarding">Continue setup</ButtonLink>
      </div>
    </Card>
  );
}
