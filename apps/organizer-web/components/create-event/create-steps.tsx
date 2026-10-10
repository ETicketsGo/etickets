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
  const tone = (status: StepStatus) =>
    status === 'error'
      ? 'bg-status-error'
      : status === 'complete' || status === 'current'
        ? 'bg-action-primary'
        : 'bg-border';
  return (
    <nav aria-label="Event creation steps">
      {/*
        Below md, a deliberate compact form: the step named in words, then five segments (one
        per step, coloured by state, each a button once reached). From md up, numbered steps
        with their names on ONE line - "Where and when" wrapping onto two lines pushed its
        connector off the line of the circles.
      */}
      <p className="mb-2 flex flex-wrap items-baseline gap-x-2 text-caption md:hidden">
        <span className="text-text-muted">
          Step {current + 1} of {steps.length}
        </span>
        <span className="font-semibold text-text-primary">{steps[current]?.title}</span>
        {attention > 0 ? (
          <span className="font-medium text-status-error">
            {attention} step{attention === 1 ? ' needs' : 's need'} attention
          </span>
        ) : null}
      </p>
      <ol className="flex items-center gap-1.5 md:gap-0">
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
              {/* Phone: a segment. */}
              <span
                aria-hidden="true"
                className={`block h-1.5 w-full rounded-full md:hidden ${tone(status)} ${
                  status === 'current' ? 'ring-2 ring-action-primary/30' : ''
                }`}
              />
              {/* md and up: circle and name. */}
              <span
                aria-hidden="true"
                className={`relative z-10 hidden h-7 w-7 shrink-0 items-center justify-center rounded-full text-caption font-semibold tabular-nums transition-colors md:flex ${
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
                className={`hidden whitespace-nowrap text-caption md:inline ${
                  status === 'current'
                    ? 'font-semibold text-text-primary'
                    : status === 'error'
                      ? 'font-medium text-status-error'
                      : 'text-text-secondary'
                }`}
              >
                {step.title}
              </span>
            </>
          );
          const last = i === steps.length - 1;
          const box =
            'flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 md:flex-none md:px-1 md:py-1';
          return (
            <li
              key={step.title}
              className={`flex min-w-0 flex-1 items-center ${last ? 'md:flex-none' : ''}`}
            >
              {visitable ? (
                <button
                  type="button"
                  onClick={() => onVisit(i)}
                  aria-label={spoken}
                  className={`${box} transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary`}
                >
                  {inner}
                </button>
              ) : (
                <span
                  role="img"
                  aria-label={spoken}
                  aria-current={status === 'current' ? 'step' : undefined}
                  className={box}
                >
                  {inner}
                </span>
              )}
              {!last ? (
                <span
                  aria-hidden="true"
                  className={`mx-2 hidden h-px min-w-4 flex-1 md:block ${
                    i < current ? 'bg-action-primary' : 'bg-border'
                  }`}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
