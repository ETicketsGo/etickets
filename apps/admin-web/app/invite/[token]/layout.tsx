import type { Metadata } from 'next';

// The tab reads "<Page> - ETicketsGo" (root layout template); this page is a client component.
export const metadata: Metadata = { title: 'Invitation' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
