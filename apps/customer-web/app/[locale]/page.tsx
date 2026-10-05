import type { Metadata } from 'next';
import { DiscoverHome } from '@/components/discover-home';

export const metadata: Metadata = {
  title: 'ETicketsGo - Book tickets for movies, concerts and live events',
  description:
    'Find what is on near you and book in a few taps. See every fee before you pay, and keep your ticket on your phone - it scans even without a signal.',
  alternates: { canonical: '/' },
};

/**
 * The front door is a ticket shop.
 *
 * ── WHAT THIS REPLACED, AND WHY ────────────────────────────────────────────────────
 * This route used to serve a marketing landing to signed-out visitors and the discovery
 * experience only to signed-in ones. Every first-time buyer - which is every buyer, once -
 * arrived at a page headed "Sell tickets. Check in guests. Grow every event.", whose primary
 * action was "Start selling tickets" and which showed not one event, film, city or showtime.
 * The browser tab read "Sell tickets, check in guests, see your sales".
 *
 * The marketplace was already built and already good; it was behind a sign-in. The buyer
 * experience here is not new work - it is `DiscoverHome`, unchanged in substance, shown to
 * the people it was built for.
 *
 * Organizer acquisition keeps its own path at `/organizers`, and the full pitch lives at
 * `/sell`. Those are secondary journeys now, which is the correct order: somebody who runs
 * events will look for us; somebody who wants a ticket tonight will not.
 */
export default function HomePage() {
  return <DiscoverHome />;
}
