'use client';

import { AlertCircle, Check } from 'lucide-react';
import type { StepStatus } from '@/lib/event-wizard';

/**
 * Where the organizer is in the create-event wizard, and a way back to any step they have
 * already been through.
 *
 * ── WHY NOT THE SHARED STEPPER ─────────────────────────────────────────────────────
 * web-kit's Stepper draws progress and nothing else: done, current, not yet. This wizard needs
 * two more things from it. A step that was passed and has since gone wrong has to SAY so -
 * changing a session to a seated room really can break the ticket step behind it - and a
 * passed step has to be a button, because "go back three steps and fix the venue" should be
 * one click, not three presses of Back. The checkout stepper in customer-web has neither need,
 * so this stays here rather than widening the shared component.
 *
 * ── WHY A GRID ─────────────────────────────────────────────────────────────────────
 * Five equal columns can never be wider than the card they sit in, which is the whole of the
 * "no sideways scrolling at 320px" requirement met by construction. Below `sm` only the
 * numbers show; the line underneath names the current step in words at every width.
 */
export function WizardSteps({
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
  const errorCount = statuses.filter((s) => s === 'error').length;
  return (
    <nav aria-label="Event creation steps">
      <ol className="grid grid-cols-5 gap-1">
        {steps.map((step, i) => {
          const status = statuses[i];
          const visitable = status !== 'current' && canVisit(i);
          // Said in words for a screen reader: colour and an icon are not a status on their own.
          const spoken = `Step ${i + 1} of ${steps.length}: ${step.title}${
            status === 'complete'
              ? ', completed'
              : status === 'error'
                ? ', needs attention'
                : status === 'current'
                  ? ', current step'
                  : ''
          }`;
          const inner = (
            <>
              <span
                aria-hidden="true"
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-caption font-semibold transition-colors ${
                  status === 'error'
                    ? 'bg-tint-error text-status-error ring-2 ring-status-error'
                    : status === 'complete'
                      ? 'bg-action-primary text-action-primary-foreground'
                      : status === 'current'
                        ? 'bg-tint-primary text-action-primary ring-2 ring-action-primary'
                        : 'bg-background-subtle text-text-muted'
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
                className={`hidden text-center text-caption leading-tight sm:block ${
                  status === 'current'
                    ? 'font-semibold text-text-primary'
                    : status === 'error'
                      ? 'font-medium text-status-error'
                      : 'text-text-muted'
                }`}
              >
                {step.title}
              </span>
            </>
          );
          return (
            <li key={step.title} className="flex min-w-0 justify-center">
              {visitable ? (
                <button
                  type="button"
                  onClick={() => onVisit(i)}
                  aria-label={spoken}
                  className="flex min-w-0 flex-col items-center gap-1 rounded-md p-1 hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary"
                >
                  {inner}
                </button>
              ) : (
                <span
                  aria-label={spoken}
                  aria-current={status === 'current' ? 'step' : undefined}
                  role="img"
                  className="flex min-w-0 flex-col items-center gap-1 p-1"
                >
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-center text-caption text-text-secondary">
        Step {current + 1} of {steps.length}: {steps[current]?.title}
        {errorCount > 0 &&
          ` - ${errorCount} step${errorCount === 1 ? ' needs' : 's need'} attention`}
      </p>
    </nav>
  );
}
