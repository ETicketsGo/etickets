import type { Metadata } from 'next';
import { PRIVATE_ROBOTS } from '@/lib/seo';

/*
  The unsubscribe page is somebody's own link from an email: a page with a name, never a
  search result. A layout because the page is a client component and `metadata` is a server
  export.
*/
export const metadata: Metadata = {
  title: 'Unsubscribe',
  description: 'Stop marketing email from ETicketsGo or from one organizer.',
  robots: PRIVATE_ROBOTS,
};

export default function UnsubscribeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
