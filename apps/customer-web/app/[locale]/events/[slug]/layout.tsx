import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/json-ld';
import { alternatesFor, localizedPath, shareCards, type ShareImage } from '@/lib/seo';
import { buildEventJsonLd, type EventForStructuredData } from '@/lib/structured-data';
import { canonicalSiteUrl } from '@/lib/site-url';
import { loadPublic } from '@/lib/public-api';

/**
 * An event page named after its event, with its own canonical URL and its Event markup.
 *
 * ── WHAT IT SAID BEFORE ────────────────────────────────────────────────────────────
 * Every customer page fell through to the root title - "ETicketsGo: Sell tickets, check in
 * guests, see your sales" - which is the pitch to ORGANIZERS. So a gig page shared to a friend
 * arrived as a sales pitch for ticketing software, and in the installed app Android's recents
 * switcher showed the same line for every screen. It also inherited the root canonical, `/`,
 * so every event told search engines that the home page was the real version of it.
 *
 * ── WHY IT FETCHES ────────────────────────────────────────────────────────────────
 * The page itself is a client component, so it cannot export metadata; this server layout can,
 * and the title is only knowable by asking. The fetch is cached by Next for an hour (and the
 * metadata and the layout share the one cached answer), so the cost is one request per event
 * per hour rather than one per visit.
 *
 * A definite 404 from the API is a 404 here too, so a mistyped or unpublished event is not a
 * "soft 404" page answering 200. A network failure is NOT a 404: the page falls back to a
 * generic title and renders, because a missing title is a smaller problem than a blank screen
 * or an event wrongly reported as gone.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

const loadEvent = (slug: string) =>
  loadPublic<EventForStructuredData>(`${API}/public/events/${encodeURIComponent(slug)}`);

/** The event's own picture for a sharing card, when the organizer uploaded one. */
function eventShareImage(event: EventForStructuredData): ShareImage[] | undefined {
  const path = event.imageVariants?.banner ?? event.imagePath;
  if (!path) return undefined;
  return [{ url: /^https?:\/\//i.test(path) ? path : `${API}${path}`, alt: event.title }];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const path = `/events/${slug}`;
  const result = await loadEvent(slug);
  // The layout answers 404 for this; a 404 page names no canonical.
  if (result.kind === 'not-found') return { title: 'Event not found', alternates: {} };
  const event = result.kind === 'ok' ? result.data : null;
  if (!event?.title) {
    // A fallback that still names this page, not the listing, as itself.
    return { title: 'Event', alternates: alternatesFor(locale, path) };
  }
  /*
    The description is the organizer's own, trimmed. Where they have written none, the title is
    left to speak for itself rather than padded with a sentence the platform made up about an
    event it has never seen.
  */
  const description = event.description?.trim().slice(0, 200) || undefined;
  return {
    title: event.title,
    ...(description ? { description } : {}),
    alternates: alternatesFor(locale, path),
    ...shareCards({
      locale,
      path,
      title: `${event.title} - ETicketsGo`,
      description,
      images: eventShareImage(event),
    }),
  };
}

export default async function EventLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const result = await loadEvent(slug);
  if (result.kind === 'not-found') notFound();
  const jsonLd =
    result.kind === 'ok'
      ? buildEventJsonLd(result.data, {
          pageUrl: `${canonicalSiteUrl()}${localizedPath(locale, `/events/${slug}`)}`,
          apiUrl: API,
        })
      : [];
  return (
    <>
      {jsonLd.length > 0 ? <JsonLd data={jsonLd.length === 1 ? jsonLd[0] : jsonLd} /> : null}
      {children}
    </>
  );
}
