'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { Button, Card, EmptyState, ErrorState, Skeleton, useToast } from '@/components/ui';
import { PushToggle } from '@/components/push-toggle';

export default function NotificationsPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['notifications', 'inbox', 'customer'],
    // CUSTOMER only — the mirror of the organizer console's filter, so a person with both
    // roles sees their tickets here and their payouts there.
    queryFn: () => api.notificationsInbox({ limit: 50, audience: 'CUSTOMER' }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });

  const markRead = useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onSuccess: invalidate,
    onError: () => toast.push('Could not update. Please try again.', 'error'),
  });
  const markAll = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: () => {
      toast.push('All caught up.', 'success');
      invalidate();
    },
    onError: () => toast.push('Could not update. Please try again.', 'error'),
  });

  const unread = data?.unreadCount ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-h3 font-bold tracking-tight text-text-primary">Notifications</h1>
        {unread > 0 && (
          <Button
            variant="outline"
            size="sm"
            loading={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </Button>
        )}
      </div>

      <PushToggle />

      {isError ? (
        <ErrorState
          message="We couldn't load your notifications. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading || !data ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Bell}
            title="No notifications yet"
            hint="Booking confirmations, reminders and refund updates will appear here."
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {data.items.map((n) => {
              const isUnread = !n.readAt;
              return (
                <li
                  key={n.id}
                  className={`flex items-start gap-3 px-2 py-4 ${isUnread ? 'bg-action-primary/5' : ''}`}
                >
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${isUnread ? 'bg-action-primary' : 'bg-transparent'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-text-primary">{n.subject}</p>
                    <p className="mt-0.5 text-[0.9375rem] text-text-secondary">{n.body}</p>
                    <p className="mt-1 text-caption text-text-muted">{dateTime(n.createdAt)}</p>
                  </div>
                  {isUnread && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={markRead.isPending && markRead.variables === n.id}
                      onClick={() => markRead.mutate(n.id)}
                    >
                      Mark read
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
