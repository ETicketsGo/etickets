import type { Metadata } from 'next';
import { NotFoundView } from '@/components/not-found-view';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: true },
};

/**
 * The 404 for any address inside a locale: a route that does not exist (through the catch-all
 * beside this file) or a page that calls `notFound()`. Rendered inside the locale layout, so it
 * has the storefront's header, footer and legal line like every other page.
 */
export default function NotFound() {
  return <NotFoundView />;
}
