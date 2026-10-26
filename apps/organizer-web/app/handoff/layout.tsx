import type { Metadata } from 'next';

// The tab reads "<Page> - ETicketsGo" (root layout template); this page is a client component.
export const metadata: Metadata = {
  title: 'Signing you in',
  // A one-time page: nothing here is worth indexing.
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
