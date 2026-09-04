'use client';

import { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { EventCard } from '@/components/event-card';
import { getSaved, type SavedEvent } from '@/lib/saved';
import { ButtonLink, EmptyState } from '@/components/ui';

export default function SavedPage() {
  const [saved, setSaved] = useState<SavedEvent[] | null>(null);

  useEffect(() => setSaved(getSaved()), []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Saved events</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Events you’ve hearted — book before they sell out.
        </p>
      </div>

      {saved === null ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-72 animate-pulse rounded-lg border border-border bg-background-subtle"
            />
          ))}
        </div>
      ) : saved.length > 0 ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {saved.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No saved events yet"
          hint="Tap the heart on any event to save it here."
          icon={Heart}
          action={<ButtonLink href="/events">Browse events</ButtonLink>}
        />
      )}
    </div>
  );
}
