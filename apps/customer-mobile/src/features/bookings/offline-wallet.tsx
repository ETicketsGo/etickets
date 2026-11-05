import { useMemo } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, haptics } from '@/ui';
import { formatEventWhen, dateParts } from '@/services/locale';
import type { CachedTicket } from '@/services/ticket-cache';
import { OfflineTicketNotice } from './offline-notice';

/**
 * The wallet with no signal: the tickets saved on this phone, one card per booking.
 *
 * The bookings list is not saved to the device, only the tickets are. So on a cold start
 * with no signal the Tickets tab said "your bookings will appear once you're back online",
 * and the saved ticket the customer needed at the gate could not be reached at all, under a
 * heading promising that tickets "open without a signal". Seen on an Android 14 emulator.
 * Each card opens the booking screen, which shows the saved pass when it cannot reach the
 * server.
 */
export interface SavedBooking {
  bookingId: string;
  reference: string | null;
  title: string;
  startsAt: string;
  timeZone?: string;
  count: number;
}

/** Saved tickets grouped by booking, soonest first. Exported for tests. */
export function groupSavedTickets(tickets: CachedTicket[]): SavedBooking[] {
  const byBooking = new Map<string, SavedBooking>();
  for (const t of tickets) {
    const existing = byBooking.get(t.bookingId);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byBooking.set(t.bookingId, {
      bookingId: t.bookingId,
      reference: t.bookingRef,
      title: t.event.title,
      startsAt: t.startsAt,
      timeZone: t.timezone ?? undefined,
      count: 1,
    });
  }
  return [...byBooking.values()].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
}

export function OfflineWallet({
  tickets,
  syncedAt,
  stale,
}: {
  tickets: CachedTicket[];
  syncedAt: number | null;
  stale: boolean;
}) {
  const router = useRouter();
  const saved = useMemo(() => groupSavedTickets(tickets), [tickets]);

  return (
    <FlatList
      data={saved}
      keyExtractor={(b) => b.bookingId}
      contentContainerClassName="gap-3 px-4 pb-8"
      ListHeaderComponent={
        <View className="pb-1">
          <OfflineTicketNotice syncedAt={syncedAt} stale={stale} />
        </View>
      }
      renderItem={({ item }) => {
        const { weekday, day, month } = dateParts(item.startsAt, item.timeZone);
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.title}. ${formatEventWhen(item.startsAt, item.timeZone)}. ${item.count} saved ${
              item.count === 1 ? 'ticket' : 'tickets'
            }`}
            accessibilityHint="Opens the saved ticket"
            onPress={() => {
              haptics.tap();
              router.push({ pathname: '/booking/[id]', params: { id: item.bookingId } });
            }}
            className="flex-row overflow-hidden rounded-card border border-border bg-background-surface active:bg-sunken"
          >
            <View
              style={{ width: 76 }}
              className="items-center justify-center gap-0.5 border-r border-dashed border-border-strong bg-ink py-4"
            >
              <Text variant="eyebrow" tone="goldOnStage">
                {month ?? ''}
              </Text>
              <Text variant="figure" tone="onStage">
                {day ?? ''}
              </Text>
              <Text variant="meta" tone="onStage2">
                {weekday ?? ''}
              </Text>
            </View>
            <View className="flex-1 gap-1 p-4">
              <Text variant="card" numberOfLines={2}>
                {item.title}
              </Text>
              <Text variant="meta" tone="secondary">
                {item.count} saved {item.count === 1 ? 'ticket' : 'tickets'}
              </Text>
              {item.reference ? (
                <Text variant="meta" tone="muted">
                  {item.reference}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      }}
    />
  );
}
