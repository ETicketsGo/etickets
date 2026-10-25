import { localizedMetadata } from '@/lib/seo';
import { MarketingLanding } from '@/components/marketing/landing';
import { BrandPage } from '@/components/storefront-brand';

export const generateMetadata = localizedMetadata('/sell', {
  title: 'Sell tickets with ETicketsGo',
  description:
    'Sell tickets, reserve seats, take payments and scan people in at the gate - including when the venue network drops.',
});

/*
  The organizer pitch, moved off `/`.

  It is a good page and it is not the front door. A buyer looking for a ticket tonight should
  not have to read a box-office pitch first; an organizer evaluating us will arrive here on
  purpose, from `/organizers`, a search, or a link we send them.
*/
export default function SellPage() {
  return (
    <BrandPage>
      <MarketingLanding />
    </BrandPage>
  );
}
