import { redirect } from 'next/navigation';

/**
 * Adding a cinema screen is adding a space of that kind.
 *
 * This page created a CINEMA and landed on it, so a person adding "Screen 2" was handed a
 * cinema page asking for a brand, a street address and a map pin, with an empty "Screens" list
 * inside the thing they had just called a screen. The new-space page asks for the venue once,
 * files the screen under the venue's cinema (creating it from the venue the first time) and
 * lands on the screen itself. The address is kept so existing links still work.
 */
export default async function NewCinemaRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { venueId } = await searchParams;
  const venue = typeof venueId === 'string' ? `&venueId=${encodeURIComponent(venueId)}` : '';
  redirect(`/organizer/spaces/new?kind=CINEMA_SCREEN${venue}`);
}
