import { redirect } from '@/i18n/navigation';

// The home page (/) now serves the discovery experience to signed-in visitors, so
// /discover just funnels there — any old links keep working.
export default async function DiscoverRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  /*
    The locale is carried across the redirect rather than dropped.

    `/fr-CA/discover` must land on `/fr-CA`, not `/`. The locale-aware `redirect` requires it
    to be named, which is why this signature grew — a redirect that silently reverts somebody
    to English is invisible in review and obvious to the person it happens to.
  */
  redirect({ href: '/', locale });
}
