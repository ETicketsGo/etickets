'use client';

import { useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { gradientFor } from '@eticketsgo/web-kit';

/**
 * A film's poster in a cinema's shape - 2:3 - or a branded placeholder when there is none.
 *
 * ── WHY IT LISTENS FOR A BROKEN IMAGE ──────────────────────────────────────────────
 * `posterUrl` is a link somebody typed, not a file we hold. The seeded films point at a host
 * that does not resolve, and a real one can be moved or deleted at any time. A broken link
 * drew the browser's broken-image icon in a box; it now falls back to the same placeholder as
 * a film with no poster, so the library reads as unfinished rather than broken.
 *
 * The placeholder is the film's own tint, a film-strip edge and a clapperboard - never a
 * giant initial (DESIGN-DIRECTION). Decorative (`alt=""`): the title is always printed next to
 * it.
 */
export function FilmPoster({
  id,
  posterUrl,
  className = '',
  iconClassName = 'h-7 w-7',
}: {
  id: string;
  posterUrl?: string | null;
  className?: string;
  iconClassName?: string;
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
          className={`absolute inset-0 flex items-center justify-center bg-gradient-to-b ${gradientFor(id)}`}
        >
          {/* Film-strip perforations down both edges: says "film" before the icon does. */}
          <span
            className="absolute inset-y-0 left-1 w-1.5 opacity-40"
            style={{
              backgroundImage:
                'repeating-linear-gradient(to bottom, hsl(var(--text-primary) / 0.35) 0 5px, transparent 5px 11px)',
            }}
          />
          <span
            className="absolute inset-y-0 right-1 w-1.5 opacity-40"
            style={{
              backgroundImage:
                'repeating-linear-gradient(to bottom, hsl(var(--text-primary) / 0.35) 0 5px, transparent 5px 11px)',
            }}
          />
          <Clapperboard className={`text-text-primary/45 ${iconClassName}`} strokeWidth={1.5} />
        </div>
      )}
    </div>
  );
}
