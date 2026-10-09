'use client';

import { Suspense } from 'react';
import { Skeleton } from '@eticketsgo/web-kit';
import { OrganizerCalendar } from '@/components/calendar/organizer-calendar';

// useSearchParams() requires a Suspense boundary during static generation.
export default function CalendarPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <OrganizerCalendar />
    </Suspense>
  );
}
