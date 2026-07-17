import { redirect } from 'next/navigation';

// The home page (/) now serves the discovery experience to signed-in visitors, so
// /discover just funnels there — any old links keep working.
export default function DiscoverRedirect() {
  redirect('/');
}
