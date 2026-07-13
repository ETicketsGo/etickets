'use client';

import { useQueries } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BadgeCheck, ChevronRight, Users } from 'lucide-react';
import { api, type OrganizerProfile } from '@/lib/api';
import { dateOnly } from '@/lib/format';
import { EmptyState, ErrorState } from '@/components/ui';

const FOLLOW_KEY = 'etg_following';

function readFollowing(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(FOLLOW_KEY) ?? '[]') as string[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function OrganizerCard({ org }: { org: OrganizerProfile }) {
  return (
    <Link
      href={`/organizers/${org.id}`}
      className="group flex items-center gap-4 rounded-lg border border-border bg-background-surface p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-action-primary text-title font-bold text-action-primary-foreground shadow-sm">
        {org.name.charAt(0)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate font-semibold text-text-primary group-hover:text-action-primary">
            {org.name}
          </p>
          {org.verified && (
            <BadgeCheck className="h-4 w-4 shrink-0 text-status-info" aria-label="Verified" />
          )}
        </div>
        <p className="mt-0.5 truncate text-caption text-text-muted">
          Since {dateOnly(org.memberSince)} · {org.eventCount} live event
          {org.eventCount === 1 ? '' : 's'}
        </p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

export default function FollowingPage() {
  const [ids, setIds] = useState<string[] | null>(null);

  useEffect(() => setIds(readFollowing()), []);

  const results = useQueries({
    queries: (ids ?? []).map((id) => ({
      queryKey: ['organizer', id],
      queryFn: () => api.organizerProfile(id),
    })),
  });

  const loading = ids === null || results.some((r) => r.isLoading);
  const allErrored = ids !== null && ids.length > 0 && results.every((r) => r.isError);
  const organizers = results
    .map((r) => r.data)
    .filter((o): o is OrganizerProfile => Boolean(o));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Following</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Organizers you follow — never miss their next drop.
        </p>
      </div>

      {ids !== null && ids.length === 0 ? (
        <EmptyState
          title="You’re not following anyone yet"
          hint="Follow organizers to see them here."
          icon={Users}
          action={<Link href="/events" className="text-action-primary hover:underline">Browse events</Link>}
        />
      ) : allErrored ? (
        <ErrorState
          message="We couldn't load the organizers you follow. Please try again."
          onRetry={() => results.forEach((r) => r.refetch())}
        />
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: ids?.length || 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-lg border border-border bg-background-subtle"
            />
          ))}
        </div>
      ) : organizers.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {organizers.map((org) => (
            <OrganizerCard key={org.id} org={org} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="You’re not following anyone yet"
          hint="Follow organizers to see them here."
          icon={Users}
          action={<Link href="/events" className="text-action-primary hover:underline">Browse events</Link>}
        />
      )}
    </div>
  );
}
