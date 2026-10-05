import type { Metadata } from 'next';
import { MarketingLanding } from '@/components/marketing/landing';

export const metadata: Metadata = {
  title: 'Sell tickets with ETicketsGo',
  description:
    'Sell tickets, reserve seats, take payments and scan people in at the gate - including when the venue network drops.',
  alternates: { canonical: '/sell' },
};

/*
  The organizer pitch, moved off `/`.

  It is a good page and it is not the front door. A buyer looking for a ticket tonight should
  not have to read a box-office pitch first; an organizer evaluating us will arrive here on
  purpose, from `/organizers`, a search, or a link we send them.
*/
export default function SellPage() {
  return <MarketingLanding />;
}
