'use client';

import type { ReactNode } from 'react';
import { Check, CircleCheck } from 'lucide-react';
import { tileClasses } from '@eticketsgo/web-kit';
import { EXPERIENCES, type ExperienceId } from './experiences';
import { ExperienceArt } from './experience-art';

/**
 * The first question: what are you organizing?
 *
 * Radio cards - real radio inputs under the cards - so it is one tab stop, the arrow keys move
 * between choices, and a screen reader announces "Concert or live music, radio button, 1 of 7"
 * followed by what it sets up. Choosing a card does not move on by itself: arrow keys select as
 * they move, and a page that jumped away on the first arrow press would be unusable from a
 * keyboard. The Continue button moves on.
 *
 * Each card leads with a drawing on its own pastel tile (see ExperienceArt), so the seven
 * choices are told apart at a glance before a word is read. On a phone the drawing shrinks to
 * a thumbnail beside the words, so all seven fit in a couple of screens instead of seven.
 *
 * `aside` takes the grid's spare cells (seven cards leave a gap in every column count), so the
 * help sits beside the choices instead of under an empty hole.
 */
export function ExperiencePicker({
  value,
  onChange,
  aside,
}: {
  value: ExperienceId | '';
  onChange: (next: ExperienceId) => void;
  aside?: ReactNode;
}) {
  return (
    <fieldset>
      <legend className="mb-3 text-ui font-semibold text-text-primary">
        Choose an experience to get started
      </legend>
      <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 2xl:grid-cols-4">
        {EXPERIENCES.map((e, i) => {
          const checked = value === e.id;
          return (
            <label
              key={e.id}
              className={`group relative flex cursor-pointer overflow-hidden rounded-lg border bg-background-surface transition-[box-shadow,border-color,transform] duration-150 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background-canvas motion-reduce:transition-none sm:flex-col ${
                checked
                  ? 'border-action-primary shadow-md ring-1 ring-action-primary'
                  : 'border-border hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md motion-reduce:hover:translate-y-0'
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
                className="absolute inset-0 z-10 m-0 cursor-pointer appearance-none opacity-0"
              />
              <span
                aria-hidden="true"
                className={`relative w-24 shrink-0 self-stretch overflow-hidden sm:h-28 sm:w-full ${tileClasses(e.tone)}`}
              >
                <ExperienceArt
                  id={e.id}
                  className="absolute inset-0 h-full w-full transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                />
                <span
                  className={`absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full shadow-sm transition-opacity duration-150 ${
                    checked
                      ? 'bg-action-primary text-action-primary-foreground opacity-100'
                      : 'opacity-0'
                  }`}
                >
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                </span>
              </span>
              <span className="flex min-w-0 flex-1 flex-col p-3 sm:p-4">
                <span id={`exp-${e.id}`} className="font-semibold text-text-primary">
                  {e.label}
                </span>
                <span
                  id={`exp-${e.id}-desc`}
                  className="mt-0.5 block text-caption text-text-secondary"
                >
                  {e.description}
                </span>
                <span
                  id={`exp-${e.id}-sets`}
                  className="mt-2 flex items-start gap-1.5 text-caption font-medium text-text-primary sm:mt-auto sm:pt-3"
                >
                  <CircleCheck
                    aria-hidden="true"
                    className="mt-px h-3.5 w-3.5 shrink-0 text-action-primary"
                  />
                  <span>
                    <span className="sr-only">Sets up: </span>
                    {e.setsUp}
                  </span>
                </span>
              </span>
            </label>
          );
        })}
        {aside ? <div className="lg:col-span-2 2xl:col-span-1">{aside}</div> : null}
      </div>
    </fieldset>
  );
}
