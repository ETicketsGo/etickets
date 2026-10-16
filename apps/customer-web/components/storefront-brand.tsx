'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Heart, Star } from 'lucide-react';
import {
  BRAND_FOCUS,
  EventArtwork,
  hasRating,
  portableImageUrl,
  useToast,
  type PublicEventCard,
  type PublicMovieCard,
} from '@eticketsgo/web-kit';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { isSaved, toggleSaved } from '@/lib/saved';
import { ContentLabelBadge } from './content-label-badge';
import { useRatingText } from './reviews/use-rating-text';

/*
  ── THE STOREFRONT'S OTHER PAGES ON THE BRAND LAYER (docs/design/DESIGN-SYSTEM.md) ──────
  Explore, Movies, the film page and My tickets were the last buyer pages still drawn in the
  old system: a cool grey canvas, blue buttons, pastel gradient tiles with a letter on them and
  a shadow on every card. The home page and the booking flow had already moved to the stage
  and paper, so a buyer crossed between two products on every click of the top navigation.

  These are the few pieces those pages share. Everything else is composed from the brand
  tokens and the home page's own parts (`components/home/parts.tsx`), so a card on Explore is
  the same card as on the home page rather than a third look-alike.
*/

/** The page's side gutters inside a full-width band, matching the header's. */
export const BRAND_WRAP = 'mx-auto max-w-shell px-4 sm:px-6 lg:px-10';

/**
 * The page on paper, out to the edges of the app shell's column.
 *
 * The shell pads every page (`main` in site-chrome); a stage band has to reach the window's
 * edges to read as a band rather than a card, so the page takes the padding back and sets its
 * own gutters with `BRAND_WRAP`. The bottom margin takes back the shell's bottom padding too,
 * or a strip of the old grey canvas showed between the page and the footer.
 */
export function BrandPage({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-brand="customer"
      className={`-mx-4 -mb-24 -mt-6 bg-brand-canvas pb-16 font-brand-text text-brand-ink sm:-mx-6 sm:-mb-10 sm:-mt-10 lg:-mx-8 lg:pb-24 ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * "Nothing here", as a quiet sunken block with the way on: a title in the display face, one
 * sentence, and an optional action. The home page's empty filter result, shared.
 */
export function BrandEmpty({
  title,
  hint,
  action,
  headingLevel = 'p',
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  headingLevel?: 'p' | 'h2';
}) {
  const Title = headingLevel;
  return (
    <div className="rounded-brand-card bg-brand-sunken px-6 py-10 text-center">
      <Title className="text-balance font-brand-display text-brand-d3 text-brand-ink">
        {title}
      </Title>
      {hint && <p className="mx-auto mt-2 max-w-prose text-brand-ui text-brand-ink-2">{hint}</p>}
      {action && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{action}</div>
      )}
    </div>
  );
}

/**
 * A film on paper: the 2:3 poster, then title, the facts and the audience rating.
 *
 * The rating used to sit on a black strip across the bottom of the poster. On the brand layer
 * text goes under the picture, not on it (DESIGN-SYSTEM.md section 6), so it is the card's last
 * line instead. It is still plain text inside the card's one link, never a control of its own,
 * and the exact count is what a screen reader hears.
 */
export function FilmCard({
  movie,
  priority = false,
}: {
  movie: PublicMovieCard;
  priority?: boolean;
}) {
  const t = useTranslations('showtimes');
  const words = useRatingText();
  const rating = hasRating(movie.rating) ? movie.rating : null;
  return (
    <Link
      href={`/movies/${movie.slug}`}
      className={`group block rounded-brand-card ${BRAND_FOCUS}`}
    >
      <div className="overflow-hidden rounded-brand-card">
        <div className="transition-transform duration-150 motion-safe:group-hover:scale-[1.02]">
          <EventArtwork
            src={portableImageUrl(movie.posterUrl)}
            sizes="(min-width: 1024px) 18vw, 42vw"
            alt={t('movie.poster', { title: movie.title })}
            title={movie.title}
            eyebrow={movie.language}
            ratio="2:3"
            priority={priority}
          />
        </div>
      </div>
      <h3 className="mt-3 line-clamp-2 font-brand-display text-brand-card text-brand-ink">
        {movie.title}
      </h3>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-brand-meta text-brand-ink-2">
        <ContentLabelBadge label={movie.contentLabel} />
        {movie.certificate && (
          <span className="inline-flex h-5 items-center rounded border border-brand-line-strong px-1.5 text-[0.6875rem] font-semibold text-brand-ink-2">
            {movie.certificate}
          </span>
        )}
        <span>
          {movie.language} - {t('card.runtime', { minutes: movie.runtimeMinutes })}
        </span>
      </p>
      {movie.genres.length > 0 && (
        <p className="mt-1 line-clamp-1 text-brand-meta text-brand-ink-3">
          {movie.genres.join(', ')}
        </p>
      )}
      {rating && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-brand-meta text-brand-ink-2">
          <span className="sr-only">{words.summary(rating)}</span>
          <span
            aria-hidden
            className="inline-flex items-center gap-1 font-semibold tabular-nums text-brand-ink"
          >
            <Star className="h-3.5 w-3.5 shrink-0 fill-current" />
            {words.outOf5(rating.average)}
          </span>
          <span aria-hidden className="tabular-nums">
            {words.votes(rating.count)}
          </span>
        </p>
      )}
    </Link>
  );
}

/**
 * Save an event to the wishlist, laid over the corner of its picture.
 *
 * A SIBLING of the card's link, positioned over it, never a button inside the link: the old
 * card nested one, which a screen reader announces as a button inside a link and which
 * swallowed the click on some phones. Shape says the state (a filled heart), not colour alone.
 */
export function SaveEventButton({ event }: { event: PublicEventCard }) {
  // The ticket page's wishlist words, so the heart says the same thing everywhere.
  const t = useTranslations('storefront.ticketDetail');
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(isSaved(event.id)), [event.id]);
  return (
    <button
      type="button"
      aria-label={saved ? t('removeFromWishlist') : t('saveToWishlist')}
      aria-pressed={saved}
      onClick={() => {
        const now = toggleSaved(event);
        setSaved(now);
        toast.push(now ? t('savedToWishlist') : t('removedFromWishlist'), 'success');
      }}
      className={`absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-brand-surface text-brand-ink shadow-brand-overlay transition-colors duration-150 hover:bg-brand-sunken ${BRAND_FOCUS}`}
    >
      <Heart className={`h-[1.125rem] w-[1.125rem] ${saved ? 'fill-current' : ''}`} aria-hidden />
    </button>
  );
}
