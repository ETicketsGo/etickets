'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import {
  api,
  Button,
  Card,
  Skeleton,
  ErrorState,
  EmptyState,
  PageHeader,
  dateTime,
  useToast,
  errorMessage,
} from '@eticketsgo/web-kit';

export default function NotificationsPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['notifications', 'inbox'],
    queryFn: () => api.notifications.inbox({ limit: 50 }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });

  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: invalidate,
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });
  const markAll = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => {
      toast.push('All caught up.', 'success');
      invalidate();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const unread = data?.unreadCount ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        action={
          unread > 0 ? (
            <Button
              variant="outline"
              size="sm"
              loading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

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
            hint="Orders, refund requests and event reminders will show up here."
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
