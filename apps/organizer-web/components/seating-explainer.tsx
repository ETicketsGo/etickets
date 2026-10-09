import { ChevronRight } from 'lucide-react';

/**
 * "How seating works", in five words and one line each.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The console uses five nouns for seating - venue, space, layout, ticket category, session -
 * and an organizer meets them on five different pages, in no particular order. Two get
 * confused all the time: a SECTION of the room (the balcony) and a TICKET CATEGORY (Premium)
 * are often the same word, and they are not the same thing. Setting the five out once, in
 * order, is cheaper than explaining the confusion on every page it causes.
 *
 * The words here are the words the pages use. If a page calls one of these something else,
 * the page is wrong.
 */

export type SeatingStep = 'venue' | 'space' | 'layout' | 'category' | 'session';

const STEPS: { key: SeatingStep; name: string; line: string }[] = [
  { key: 'venue', name: 'Venue', line: 'The place, with its address.' },
  { key: 'space', name: 'Space', line: 'A room inside it: a screen, a hall, an arena.' },
  {
    key: 'layout',
    name: 'Layout',
    line: 'The seats, aisles and accessible places. Frozen once it is published.',
  },
  {
    key: 'category',
    name: 'Ticket category',
    line: 'What a seat costs. A price, not a place in the room.',
  },
  {
    key: 'session',
    name: 'Session',
    line: 'One date and time. It keeps the layout version it was sold from.',
  },
];

export function SeatingExplainer({ current }: { current?: SeatingStep }) {
  return (
    <section
      aria-labelledby="how-seating-works"
      data-testid="seating-explainer"
      className="rounded-lg border border-border bg-background-surface p-4"
    >
      <h2 id="how-seating-works" className="text-sm font-semibold text-text-primary">
        How seating works
      </h2>
      <ol className="mt-3 grid gap-2 sm:grid-cols-5 sm:gap-1">
        {STEPS.map((step, i) => {
          const here = step.key === current;
          return (
            <li key={step.key} className="flex items-stretch gap-1">
              <div
                aria-current={here ? 'step' : undefined}
                className={`flex-1 rounded-md border px-2.5 py-2 ${
                  here ? 'border-action-primary bg-tint-primary' : 'border-border'
                }`}
              >
                <p className="text-caption font-semibold text-text-primary">
                  <span className="tabular-nums text-text-muted">{i + 1}.</span> {step.name}
                </p>
                <p className="mt-0.5 text-caption leading-snug text-text-muted">{step.line}</p>
              </div>
              {i < STEPS.length - 1 ? (
                <ChevronRight
                  aria-hidden
                  className="hidden h-4 w-4 shrink-0 self-center text-text-muted sm:block"
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
