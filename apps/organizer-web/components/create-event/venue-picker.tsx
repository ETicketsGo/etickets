'use client';

import { useMemo, useState } from 'react';
import { Armchair, MapPin, Search } from 'lucide-react';
import type { Venue } from '@eticketsgo/web-kit';

/** How many venues are listed before the organizer is asked to search. */
const SHOWN = 6;

/**
 * Choosing one of the organization's venues.
 *
 * ── WHY NOT THE DROPDOWN ───────────────────────────────────────────────────────────
 * The venue was a closed <select> of "Name — City" lines. An organizer with twenty venues had
 * to open it and scroll, could not search, and could not see the two facts that decide the
 * next steps: the country (it sets the currency) and whether the venue has a seat map
 * (it decides whether reserved seating is on offer). Here each venue is a radio with those
 * facts beside it, and a search box appears once there are enough venues to need one.
 *
 * Radios, so it is one tab stop with arrow keys. The selected venue stays listed even when the
 * search would hide it, so a choice is never made invisible by typing.
 */
export function VenuePicker({
  venues,
  seatMapVenueIds,
  value,
  onChange,
  error,
  onBlur,
}: {
  venues: Venue[];
  /** Venues with at least one space that has a published seat map. */
  seatMapVenueIds: ReadonlySet<string>;
  value: string;
  onChange: (venueId: string) => void;
  error?: string;
  onBlur?: () => void;
}) {
  const [query, setQuery] = useState('');
  const searchable = venues.length > SHOWN;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const found = q
      ? venues.filter((v) =>
          /*
            Typed as strings, but older rows hold null country or city - so each is
            read as text before it is searched, or one old venue breaks the search.
          */
          [v.name, v.city, v.address, v.country].some((f) => (f ?? '').toLowerCase().includes(q)),
        )
      : venues;
    const shown = found.slice(0, SHOWN);
    const chosen = venues.find((v) => v.id === value);
    if (chosen && !shown.includes(chosen)) shown.unshift(chosen);
    return { shown, total: found.length };
  }, [venues, query, value]);

  return (
    <fieldset aria-describedby={error ? 'venue-error' : 'venue-hint'}>
      <legend className="mb-1.5 text-[0.8125rem] font-medium text-text-secondary">Venue</legend>
      {searchable ? (
        <div className="relative mb-2">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
          />
          <input
            type="search"
            aria-label="Search your venues"
            placeholder="Search by name or city"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-border-input bg-background-surface py-2 pl-9 pr-3 text-[0.9375rem] text-text-primary placeholder:text-text-muted focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/15"
          />
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {matches.shown.map((v, i) => {
          const checked = v.id === value;
          const seats = seatMapVenueIds.has(v.id);
          return (
            <label
              key={v.id}
              className={`relative flex cursor-pointer flex-col rounded-md border px-3 py-2.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-action-primary focus-within:ring-offset-1 focus-within:ring-offset-background-canvas ${
                checked
                  ? 'border-action-primary bg-tint-primary'
                  : error
                    ? 'border-status-error bg-background-surface hover:bg-background-subtle'
                    : 'border-border-input bg-background-surface hover:bg-background-subtle'
              }`}
            >
              <input
                type="radio"
                name="venue"
                // The first option carries the id, so "fix this field" focuses the group.
                id={i === 0 ? 'venue' : undefined}
                value={v.id}
                checked={checked}
                onChange={() => onChange(v.id)}
                onBlur={onBlur}
                aria-labelledby={`venue-${v.id}`}
                aria-describedby={`venue-${v.id}-facts`}
                className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-md opacity-0"
              />
              <span id={`venue-${v.id}`} className="font-medium text-text-primary">
                {v.name}
              </span>
              <span
                id={`venue-${v.id}-facts`}
                className={`mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption ${checked ? 'text-text-secondary' : 'text-text-muted'}`}
              >
                <span className="inline-flex items-center gap-1">
                  <MapPin aria-hidden="true" className="h-3 w-3" />
                  {[v.city, v.country].filter(Boolean).join(', ')}
                </span>
                {v.capacity ? <span>Holds {v.capacity.toLocaleString()}</span> : null}
                {seats ? (
                  <span className="inline-flex items-center gap-1">
                    <Armchair aria-hidden="true" className="h-3 w-3" />
                    Seat map
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {matches.total === 0 ? (
        <p className="mt-2 text-caption text-text-muted">
          No venue matches &quot;{query}&quot;. Check the spelling, or add it as a new venue.
        </p>
      ) : matches.total > SHOWN ? (
        <p className="mt-2 text-caption text-text-muted">
          Showing {SHOWN} of {matches.total}. Search to find the others.
        </p>
      ) : null}
      {error ? (
        <p id="venue-error" role="alert" className="mt-1.5 text-caption text-status-error">
          {error}
        </p>
      ) : (
        <p id="venue-hint" className="mt-1.5 text-caption text-text-muted">
          The venue&apos;s country sets the currency you sell in.
        </p>
      )}
    </fieldset>
  );
}
