'use client';

import { useQuery } from '@tanstack/react-query';
import { api, Badge, Card, Skeleton, recordedAt } from '@eticketsgo/web-kit';
import { channelName, messageName, orderMessages, verdictPill } from '../lib/message-delivery';

/**
 * "Did they get it?" for one booking: every message sent about it, and what became of each.
 *
 * Support used to have no answer to "the customer says the ticket never came" short of a
 * database prompt, and the row it would have found said SENT for messages that went nowhere.
 * The pill and the sentence come from the API's reading of every fact on the row.
 *
 * Needs the operations read permission. Without it the API refuses and this card is left
 * out, exactly like the history card below it.
 */
export function BookingMessages({ bookingId }: { bookingId: string }) {
  const q = useQuery({
    queryKey: ['admin', 'notifications', 'booking', bookingId],
    queryFn: () => api.admin.notifications({ bookingId, limit: 50 }),
    retry: false,
  });
  if (q.isError) return null;
  const rows = orderMessages(q.data ?? []);
  return (
    <Card title="Messages to the buyer">
      {q.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-muted">No messages have been sent about this booking.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((m) => {
            // An API older than the delivery reading sends none; say only what it stored.
            const pill = m.delivery
              ? verdictPill(m.delivery.verdict)
              : { word: `Recorded as ${m.status.toLowerCase()}`, tone: 'neutral' as const };
            return (
              <li key={m.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-text-primary">
                    {messageName(m.type)} - {channelName(m.channel)}
                  </p>
                  <Badge tone={pill.tone}>{pill.word}</Badge>
                </div>
                {m.delivery && <p className="text-sm text-text-secondary">{m.delivery.label}</p>}
                <p className="text-caption text-text-muted">
                  {[m.recipient, recordedAt(m.createdAt)].filter(Boolean).join(' - ')}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
