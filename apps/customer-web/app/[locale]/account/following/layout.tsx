import type { Metadata } from 'next';

/*
  A screen with a name.

  Every customer page fell through to the root title - "ETicketsGo: Sell tickets, check in
  guests, see your sales" - which is the pitch to ORGANIZERS. In the installed app that string
  is what Android shows in the recents switcher, and it is what a shared link carries. A person
  looking at their tickets was handed a sales pitch for the product they had already bought
  from. The title template turns this into "Following - ETicketsGo".

  A layout rather than the page, because these pages are client components and `metadata` is a
  server export. It renders its children and nothing else.
*/
export const metadata: Metadata = {
  title: 'Following',
  description: 'Organizers you follow.',
};

export default function SectionLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
