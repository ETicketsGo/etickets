import { redirect } from 'next/navigation';

/**
 * A cinema screen's layouts are on the screen's own page now, the same page every space has.
 * This address is kept so links and bookmarks to it still arrive somewhere useful.
 */
export default async function ScreenLayoutsRedirect({
  params,
}: {
  params: Promise<{ id: string; screenId: string }>;
}) {
  const { screenId } = await params;
  redirect(`/organizer/spaces/${encodeURIComponent(screenId)}`);
}
