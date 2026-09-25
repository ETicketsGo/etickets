import type { Metadata } from 'next';

/*
  A screen with a name.

  Without this the page falls through to the root title - "ETicketsGo: Sell tickets, check in
  guests, see your sales" - which is the pitch to ORGANIZERS. In the installed app that string is
  what Android shows in the recents switcher, and it is what a shared link carries, so a customer
  opening a shared ticket was handed a sales pitch.

  A layout rather than the page, because these pages are client components and `metadata` is a
  server export. It renders its children and nothing else.
*/
export const metadata: Metadata = {
  title: 'A ticket shared with you',
  description: 'Open a ticket somebody shared with you.',
};

export default function SectionLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
