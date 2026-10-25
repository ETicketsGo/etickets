import { shareImage } from '@/lib/share-image';

/** The same card for X/Twitter, which asks for its own image. See `opengraph-image.tsx`. */
export const alt = 'ETicketsGo - discover and book movies, events and experiences';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function TwitterImage() {
  return shareImage();
}
