import { redirect } from 'next/navigation';

/**
 * A space's layouts are on the space's own page now, beside what the space is and where it is.
 * This address is kept so links and bookmarks to it still arrive somewhere useful.
 */
export default async function SpaceLayoutsRedirect({
  params,
}: {
  params: Promise<{ screenId: string }>;
}) {
  const { screenId } = await params;
  redirect(`/organizer/spaces/${encodeURIComponent(screenId)}`);
}
