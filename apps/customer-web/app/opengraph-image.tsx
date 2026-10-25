import { shareImage } from '@/lib/share-image';

/**
 * The site's sharing picture: the card a link to the storefront shows in a chat, a post or a
 * search result. There was none, so every shared link went out as bare text.
 *
 * Drawn at build time from the brand tokens (paper, ink, gold) with the font `next/og`
 * bundles, so nothing is fetched while it renders. Pages with a picture of their own (an
 * event's poster) use that instead; see `lib/seo.ts`.
 */
export const alt = 'ETicketsGo - discover and book movies, events and experiences';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return shareImage();
}
