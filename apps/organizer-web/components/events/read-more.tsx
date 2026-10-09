'use client';

import { useId, useState } from 'react';
import { isLongText } from './event-overview-model';

/**
 * Somebody's own long text, folded to a few lines with a way to read the rest.
 *
 * The description used to print in full in a narrow card: a long one made the overview a page
 * of prose with the figures below the fold. Line breaks are kept (`whitespace-pre-line`), so a
 * set list typed one line per song still reads as a list, and a long unbroken word - a pasted
 * link - wraps instead of widening the page.
 */
export function ReadMore({ text, className = '' }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = isLongText(text);
  return (
    <div className={className}>
      <p
        id={id}
        className={`whitespace-pre-line break-words text-[0.9375rem] leading-relaxed text-text-secondary [overflow-wrap:anywhere] ${
          long && !open ? 'line-clamp-5' : ''
        }`}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="mt-1.5 rounded text-[0.875rem] font-medium text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {open ? 'Show less' : 'Read more'}
        </button>
      ) : null}
    </div>
  );
}
