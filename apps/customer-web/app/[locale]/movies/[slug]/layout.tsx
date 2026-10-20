import type { Metadata } from 'next';

/**
 * A film page named after its film: "<Film> - ETicketsGo".
 *
 * It inherited "Movies - ETicketsGo" from the section, so every film tab, bookmark and shared
 * link said "Movies". The same fix as `events/[slug]/layout.tsx`: the page is a client
 * component, so this server layout asks the public catalogue for the title, cached for an
 * hour, and falls back to the section's name if the ask fails rather than failing the page.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

async function loadMovie(slug: string): Promise<{ title?: string } | null> {
  try {
    const res = await fetch(`${API}/public/movies/${encodeURIComponent(slug)}`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as { title?: string };
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const movie = await loadMovie(slug);
  return movie?.title ? { title: movie.title } : {};
}

export default function MovieLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
