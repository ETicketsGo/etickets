import type { Metadata } from 'next';
import { HomeGate } from '@/components/home-gate';

export const metadata: Metadata = {
  title: 'ETicketsGo — Sell tickets, check in guests, understand your events',
  description:
    'The all-in-one platform to sell tickets, manage reserved seating, take payments, check in attendees online or offline, and understand every event with built-in analytics.',
  alternates: { canonical: '/' },
};

// One home for everyone: marketing landing for signed-out visitors, the in-app
// discovery experience for signed-in users (see HomeGate + SiteChrome).
export default function HomePage() {
  return <HomeGate />;
}
