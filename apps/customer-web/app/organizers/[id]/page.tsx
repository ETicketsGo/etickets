'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BadgeCheck, CalendarDays } from 'lucide-react';
import { useToast } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { dateOnly } from '@/lib/format';
import { EventCard } from '@/components/event-card';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';

const FOLLOW_KEY = 'etg_following';

export default function OrganizerProfilePage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [following, setFollowing] = useState(false);

  const {
    data: org,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['organizer', id],
    queryFn: () => api.organizerProfile(id),
  });

  useEffect(() => {
    try {
      const list = JSON.parse(localStorage.getItem(FOLLOW_KEY) ?? '[]') as string[];
      setFollowing(list.includes(id));
    } catch {
      /* ignore */
    }
  }, [id]);

  const toggleFollow = () => {
    try {
      const list = JSON.parse(localStorage.getItem(FOLLOW_KEY) ?? '[]') as string[];
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      localStorage.setItem(FOLLOW_KEY, JSON.stringify(next));
      const nowFollowing = next.includes(id);
      setFollowing(nowFollowing);
      toast.push(nowFollowing ? 'Following' : 'Unfollowed', 'success');
    } catch {
      /* ignore */
    }
  };

  if (isError)
    return (
      <ErrorState
        message="We couldn't load this organizer. Please try again."
        onRetry={() => refetch()}
      />
    );
  if (isLoading || !org) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-8">
      {/* Profile header */}
      <div className="overflow-hidden rounded-lg border border-border shadow-sm">
        <div className="h-28 bg-gradient-to-br from-action-primary/25 via-action-primary/10 to-background-subtle" />
        <div className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-end gap-4">
            <div className="-mt-12 flex h-20 w-20 items-center justify-center rounded-2xl border-4 border-background-surface bg-action-primary text-h3 font-bold text-action-primary-foreground shadow-md">
              {org.name.charAt(0)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-h3 font-bold tracking-tight text-text-primary">{org.name}</h1>
                {org.verified && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-status-info/12 px-2 py-0.5 text-caption font-medium text-status-info"
                    title="Verified organizer"
                  >
                    <BadgeCheck className="h-3.5 w-3.5" /> Verified
                  </span>
                )}
              </div>
              <p className="mt-1 flex items-center gap-1.5 text-caption text-text-muted">
                <CalendarDays className="h-3.5 w-3.5" />
                Organizer since {dateOnly(org.memberSince)} · {org.eventCount} live event
                {org.eventCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          <Button variant={following ? 'outline' : 'primary'} onClick={toggleFollow}>
            {following ? 'Following' : 'Follow'}
          </Button>
        </div>
      </div>

      {/* Their events */}
      <section className="space-y-5">
        <h2 className="text-title font-semibold text-text-primary">Events by {org.name}</h2>
        {org.events.length > 0 ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {org.events.map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No live events right now"
            hint="Follow to hear when new events go on sale."
          />
        )}
      </section>
    </div>
  );
}
