import type { Metadata } from 'next';

/**
 * An event page named after its event.
 *
 * ── WHAT IT SAID BEFORE ────────────────────────────────────────────────────────────
 * Every customer page fell through to the root title - "ETicketsGo: Sell tickets, check in
 * guests, see your sales" - which is the pitch to ORGANIZERS. So a gig page shared to a friend
 * arrived as a sales pitch for ticketing software, and in the installed app Android's recents
 * switcher showed the same line for every screen.
 *
 * Giving the sections their own titles fixed the lists and made this page worse for a moment:
 * `/events/[slug]` sat inside the `/events` segment and inherited "Browse events", so an event
 * page claimed to be the listing. A detail page has to name the thing it is showing.
 *
 * ── WHY IT FETCHES ────────────────────────────────────────────────────────────────
 * The page itself is a client component, so it cannot export metadata; this server layout can,
 * and the title is only knowable by asking. The fetch is cached by Next for an hour, so the
 * cost is one request per event per hour rather than one per visit, and a failure falls back to
 * a generic title rather than taking the page down with it - a missing title is a smaller
 * problem than a blank screen.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

async function loadEvent(slug: string): Promise<{ title?: string; description?: string } | null> {
  try {
    const res = await fetch(`${API}/public/events/${encodeURIComponent(slug)}`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as { title?: string; description?: string };
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
  const event = await loadEvent(slug);
  if (!event?.title) return { title: 'Event' };
  /*
    The description is the organizer's own, trimmed. Where they have written none, the title is
    left to speak for itself rather than padded with a sentence the platform made up about an
    event it has never seen.
  */
  const description = event.description?.trim();
  return {
    title: event.title,
    ...(description ? { description: description.slice(0, 200) } : {}),
    openGraph: {
      title: event.title,
      ...(description ? { description: description.slice(0, 200) } : {}),
      type: 'website',
    },
  };
}

export default function EventLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
