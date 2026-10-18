'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrandButton, brandButtonClasses } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useToast } from '@/components/ui';
import { PushToggle } from '@/components/push-toggle';
import { ACCOUNT_PANEL, AccountHeading, AccountPage, BrandError } from '@/components/account-brand';
import { Placeholder } from '@/components/home/parts';
import { BrandEmpty } from '@/components/storefront-brand';

/*
  The inbox on the brand layer: one flat white panel on paper, a row per message, an unread
  one marked by an ink dot AND by its "Mark read" button (never by a tint alone). It was the
  kit's card with a blue wash on unread rows. Same messages, same order, same actions.
*/

export default function NotificationsPage() {
  const { dateTime } = useFormat();
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['notifications', 'inbox', 'customer'],
    // CUSTOMER only — the mirror of the organizer console's filter, so a person with both
    // roles sees their tickets here and their payouts there.
    queryFn: () => api.notificationsInbox({ limit: 50 }),
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
    <AccountPage>
      <AccountHeading
        title="Notifications"
        action={
          unread > 0 && (
            <BrandButton
              variant="secondary"
              aria-busy={markAll.isPending || undefined}
              disabled={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </BrandButton>
          )
        }
      />

      <PushToggle />

      {isError ? (
        <BrandError
          message="We couldn't load your notifications. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading || !data ? (
        <div className="space-y-3" aria-busy="true">
          <Placeholder className="h-20 w-full" />
          <Placeholder className="h-20 w-full" />
          <Placeholder className="h-20 w-full" />
        </div>
      ) : data.items.length === 0 ? (
        <BrandEmpty
          title="No notifications yet"
          hint="Booking confirmations, reminders and refund updates will appear here."
          headingLevel="h2"
        />
      ) : (
        <div className={`${ACCOUNT_PANEL} px-4 sm:px-5`}>
          <ul className="divide-y divide-brand-line">
            {data.items.map((n) => {
              const isUnread = !n.readAt;
              return (
                <li key={n.id} className="flex items-start gap-3 py-4">
                  <span
                    aria-hidden
                    className={`mt-2 h-2 w-2 shrink-0 rounded-full ${isUnread ? 'bg-brand-ink' : 'bg-transparent'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-brand-body text-brand-ink ${isUnread ? 'font-semibold' : 'font-medium'}`}
                    >
                      {n.subject}
                    </p>
                    <p className="mt-0.5 text-brand-ui text-brand-ink-2">{n.body}</p>
                    <p className="mt-1 text-brand-meta tabular-nums text-brand-ink-3">
                      {dateTime(n.createdAt)}
                    </p>
                  </div>
                  {isUnread && (
                    <button
                      type="button"
                      className={`${brandButtonClasses('quiet', 'md')} shrink-0 px-3`}
                      aria-busy={(markRead.isPending && markRead.variables === n.id) || undefined}
                      disabled={markRead.isPending && markRead.variables === n.id}
                      onClick={() => markRead.mutate(n.id)}
                    >
                      Mark read
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </AccountPage>
  );
}
