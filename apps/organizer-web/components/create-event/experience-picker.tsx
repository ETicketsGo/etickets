'use client';

import { Check } from 'lucide-react';
import { EXPERIENCES, type ExperienceId } from './experiences';

/**
 * The first question: what are you organizing?
 *
 * Radio cards - real radio inputs under the cards - so it is one tab stop, the arrow keys move
 * between choices, and a screen reader announces "Concert or live music, radio button, 1 of 7"
 * followed by what it sets up. Choosing a card does not move on by itself: arrow keys select as
 * they move, and a page that jumped away on the first arrow press would be unusable from a
 * keyboard. The Continue button moves on.
 */
export function ExperiencePicker({
  value,
  onChange,
}: {
  value: ExperienceId | '';
  onChange: (next: ExperienceId) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-3 text-[0.9375rem] font-medium text-text-secondary">
        Choose an experience to get started
      </legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {EXPERIENCES.map((e, i) => {
          const checked = value === e.id;
          const Icon = e.icon;
          return (
            <label
              key={e.id}
              className={`group relative flex cursor-pointer gap-3 rounded-lg border p-3 sm:p-4 transition-[box-shadow,border-color,background-color] duration-150 focus-within:ring-2 focus-within:ring-action-primary focus-within:ring-offset-2 focus-within:ring-offset-background-canvas motion-reduce:transition-none ${
                checked
                  ? 'border-action-primary bg-tint-primary'
                  : 'border-border bg-background-surface hover:border-border-strong hover:shadow-sm'
              }`}
            >
              <input
                type="radio"
                name="experience"
                // The first card carries the id, so "fix this" can focus the group.
                id={i === 0 ? 'experience' : undefined}
                value={e.id}
                checked={checked}
                onChange={() => onChange(e.id)}
                aria-labelledby={`exp-${e.id}`}
                aria-describedby={`exp-${e.id}-desc exp-${e.id}-sets`}
                className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-lg opacity-0"
              />
              <span
                aria-hidden="true"
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md sm:h-10 sm:w-10 ${
                  checked
                    ? 'bg-action-primary text-action-primary-foreground'
                    : 'bg-background-subtle text-text-secondary group-hover:text-text-primary'
                }`}
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-2">
                  <span id={`exp-${e.id}`} className="font-semibold text-text-primary">
                    {e.label}
                  </span>
                  {checked ? (
                    <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-action-primary" />
                  ) : null}
                </span>
                <span
                  id={`exp-${e.id}-desc`}
                  className={`mt-0.5 block text-caption ${checked ? 'text-text-secondary' : 'text-text-muted'}`}
                >
                  {e.description}
                </span>
                <span
                  id={`exp-${e.id}-sets`}
                  className="mt-1 block text-caption font-medium text-text-secondary sm:mt-2"
                >
                  <span className="sr-only">Sets up: </span>
                  {e.setsUp}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
