import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { alternatesFor, shareCards } from '@/lib/seo';
import { loadPublic } from '@/lib/public-api';

/**
 * A film page named after its film: "<Film> - ETicketsGo", with its own canonical URL.
 *
 * It inherited "Movies - ETicketsGo" from the section, so every film tab, bookmark and shared
 * link said "Movies". The same fix as `events/[slug]/layout.tsx`: the page is a client
 * component, so this server layout asks the public catalogue for the title, cached for an
 * hour, and falls back to the section's name if the ask fails rather than failing the page.
 * A definite 404 from the API (no such film, or not published) is a 404 here too; a network
 * failure is not.
 *
 * The sharing card keeps the site's own picture: a stored poster URL can carry an API host
 * that no longer exists (see `portableImageUrl` in web-kit), and a broken image is worse than none.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

interface PublicMovieResponse {
  title?: string;
  synopsis?: string | null;
}

const loadMovie = (slug: string) =>
  loadPublic<PublicMovieResponse>(`${API}/public/movies/${encodeURIComponent(slug)}`);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const path = `/movies/${slug}`;
  const result = await loadMovie(slug);
  // The layout answers 404 for this; a 404 page names no canonical.
  if (result.kind === 'not-found') return { title: 'Film not found', alternates: {} };
  const movie = result.kind === 'ok' ? result.data : null;
  if (!movie?.title) return { alternates: alternatesFor(locale, path) };
  const description = movie.synopsis?.trim().slice(0, 200) || undefined;
  return {
    title: movie.title,
    ...(description ? { description } : {}),
    alternates: alternatesFor(locale, path),
    ...shareCards({ locale, path, title: `${movie.title} - ETicketsGo`, description }),
  };
}

export default async function MovieLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if ((await loadMovie(slug)).kind === 'not-found') notFound();
  return <>{children}</>;
}
