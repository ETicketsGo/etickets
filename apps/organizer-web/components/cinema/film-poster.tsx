'use client';

import { useState } from 'react';
import { Clapperboard } from 'lucide-react';

/**
 * A film's poster in a cinema's shape - 2:3 - or a branded placeholder when there is none.
 *
 * ── WHY IT LISTENS FOR A BROKEN IMAGE ──────────────────────────────────────────────
 * `posterUrl` is a link somebody typed, not a file we hold. The seeded films point at a host
 * that does not resolve, and a real one can be moved or deleted at any time. A broken link
 * drew the browser's broken-image icon in a box; it now falls back to the same placeholder as
 * a film with no poster, so the library reads as unfinished rather than broken.
 *
 * ONE placeholder, the same for "no poster" and "poster link broken": the console's teal
 * tint, film-strip edges, a clapperboard and the words "No poster". It used to take a
 * per-film colour, which beside real posters read as a second, paler kind of artwork rather
 * than as a gap to fill. Never a giant initial (DESIGN-DIRECTION). The image is decorative
 * (`alt=""`): the title is always printed next to it.
 */
export function FilmPoster({
  posterUrl,
  className = '',
  iconClassName = 'h-7 w-7',
  compact = false,
}: {
  posterUrl?: string | null;
  className?: string;
  iconClassName?: string;
  /** A thumbnail too small for the words. */
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const src = posterUrl && !failed ? posterUrl : null;
  return (
    <div
      className={`relative aspect-[2/3] shrink-0 overflow-hidden rounded-md border border-border bg-background-subtle ${className}`}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-tint-primary"
          style={{
            backgroundImage:
              'radial-gradient(circle at 50% 38%, hsl(var(--action-primary) / 0.14), transparent 62%)',
          }}
        >
          {/* Film-strip perforations down both edges: says "film" before the icon does. */}
          {['left-1', 'right-1'].map((side) => (
            <span
              key={side}
              className={`absolute inset-y-0 ${side} w-1.5`}
              style={{
                backgroundImage:
                  'repeating-linear-gradient(to bottom, hsl(var(--action-primary) / 0.28) 0 5px, transparent 5px 11px)',
              }}
            />
          ))}
          <Clapperboard className={`text-action-primary/70 ${iconClassName}`} strokeWidth={1.5} />
          {compact ? null : (
            <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-action-primary/80">
              No poster
            </span>
          )}
        </div>
      )}
    </div>
  );
}
