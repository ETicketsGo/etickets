'use client';

import { AlertCircle, Check } from 'lucide-react';
import type { StepStatus } from '@/lib/event-wizard';

/**
 * Where the organizer is, and a way back to any step already seen.
 *
 * Each step says in words whether it is done, needs attention or has not been reached - an icon
 * and a colour are never the only signal. A step already reached is a button: "go back and fix
 * the venue" is one click. Steps not reached yet are not buttons, because Continue is what
 * checks the step in between.
 *
 * On a phone the names are hidden and the line underneath names the current step, so five
 * steps never scroll sideways at 320px.
 */
export function CreateSteps({
  steps,
  current,
  statuses,
  canVisit,
  onVisit,
}: {
  steps: readonly { title: string }[];
  current: number;
  statuses: StepStatus[];
  canVisit: (index: number) => boolean;
  onVisit: (index: number) => void;
}) {
  const attention = statuses.filter((s) => s === 'error').length;
  return (
    <nav aria-label="Event creation steps">
      <ol className="flex items-start">
        {steps.map((step, i) => {
          const status = statuses[i];
          const visitable = status !== 'current' && canVisit(i);
          const state =
            status === 'complete'
              ? 'done'
              : status === 'error'
                ? 'needs attention'
                : status === 'current'
                  ? 'current step'
                  : 'not started';
          const spoken = `Step ${i + 1} of ${steps.length}: ${step.title}, ${state}`;
          const inner = (
            <>
              <span
                aria-hidden="true"
                className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-caption font-semibold tabular-nums transition-colors ${
                  status === 'error'
                    ? 'bg-tint-error text-status-error ring-2 ring-status-error'
                    : status === 'complete'
                      ? 'bg-action-primary text-action-primary-foreground'
                      : status === 'current'
                        ? 'bg-background-surface text-action-primary ring-2 ring-action-primary'
                        : 'bg-background-subtle text-text-muted ring-1 ring-border'
                }`}
              >
                {status === 'error' ? (
                  <AlertCircle className="h-4 w-4" />
                ) : status === 'complete' ? (
                  <Check className="h-4 w-4" />
                ) : (
                  i + 1
                )}
              </span>
              <span
                aria-hidden="true"
                className={`hidden text-left text-caption leading-tight md:block ${
                  status === 'current'
                    ? 'font-semibold text-text-primary'
                    : status === 'error'
                      ? 'font-medium text-status-error'
                      : 'text-text-secondary'
                }`}
              >
                {step.title}
                {status === 'error' ? (
                  <span className="block font-normal">Needs attention</span>
                ) : null}
              </span>
            </>
          );
          const last = i === steps.length - 1;
          return (
            <li key={step.title} className={`flex min-w-0 items-center ${last ? '' : 'flex-1'}`}>
              {visitable ? (
                <button
                  type="button"
                  onClick={() => onVisit(i)}
                  aria-label={spoken}
                  className="flex min-w-0 items-center gap-2 rounded-md p-1 transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary"
                >
                  {inner}
                </button>
              ) : (
                <span
                  role="img"
                  aria-label={spoken}
                  aria-current={status === 'current' ? 'step' : undefined}
                  className="flex min-w-0 items-center gap-2 p-1"
                >
                  {inner}
                </span>
              )}
              {!last ? (
                <span
                  aria-hidden="true"
                  className={`mx-1 h-px min-w-3 flex-1 ${
                    i < current ? 'bg-action-primary' : 'bg-border'
                  }`}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-caption text-text-secondary md:sr-only">
        Step {current + 1} of {steps.length}: {steps[current]?.title}
        {attention > 0 && ` - ${attention} step${attention === 1 ? ' needs' : 's need'} attention`}
      </p>
    </nav>
  );
}
