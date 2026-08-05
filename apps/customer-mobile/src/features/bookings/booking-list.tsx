import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { EmptyState, ErrorState, Skeleton } from '@/components/states';
import { Badge, Chip, Text, haptics } from '@/ui';
import { useTheme } from '@/theme';
import { useNow } from '@/hooks/use-now';
import { formatDateTime, formatMoney } from '@/services/locale';
import { useBookings } from './api';
import { bookingTone, type Booking } from './schema';

type Filter = 'upcoming' | 'past';

/**
 * The customer's bookings, split into what is still to come and what has been.
 *
 * The split is by SESSION time, not by booking status: a confirmed booking for last
 * month and a confirmed booking for tomorrow are the same status but the user is
 * looking for exactly one of them, and it is always the upcoming one.
 */
export function BookingList() {
  const router = useRouter();
  const { colors } = useTheme();
  const [filter, setFilter] = useState<Filter>('upcoming');
  const { data, isPending, isError, refetch, isRefetching } = useBookings();

  // A minute's granularity is ample for an upcoming/past split, and keeps this list
  // from re-partitioning once a second while the user scrolls it.
  const now = useNow(60_000);

  const { upcoming, past } = useMemo(() => {
    const all = data?.data ?? [];
    return {
      upcoming: all
        .filter((b) => new Date(b.eventSession.startsAt).getTime() >= now)
        .sort(
          (a, b) =>
            new Date(a.eventSession.startsAt).getTime() -
            new Date(b.eventSession.startsAt).getTime(),
        ),
      // Most recent first — the thing someone wants a receipt for is the last one.
      past: all
        .filter((b) => new Date(b.eventSession.startsAt).getTime() < now)
        .sort(
          (a, b) =>
            new Date(b.eventSession.startsAt).getTime() -
            new Date(a.eventSession.startsAt).getTime(),
        ),
    };
  }, [data, now]);

  if (isPending) {
    return (
      <View className="gap-3 px-5 pt-3">
        {[0, 1, 2].map((i) => (
          <View key={i} className="gap-2 rounded-md border border-border p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </View>
        ))}
      </View>
    );
  }

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load your bookings"
        message="We couldn't reach the server. Pull to refresh once you're back online."
        onRetry={() => void refetch()}
      />
    );
  }

  const shown = filter === 'upcoming' ? upcoming : past;

  return (
    <FlatList
      data={shown}
      keyExtractor={(b) => b.id}
      renderItem={({ item }) => <BookingCard booking={item} />}
      contentContainerClassName="pb-8"
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={() => void refetch()}
          tintColor={colors.textMuted}
        />
      }
      ListHeaderComponent={
        <View className="flex-row gap-2 px-5 pb-3 pt-1">
          <Chip
            label={`Upcoming${upcoming.length ? ` (${upcoming.length})` : ''}`}
            selected={filter === 'upcoming'}
            onPress={() => setFilter('upcoming')}
          />
          <Chip
            label={`Past${past.length ? ` (${past.length})` : ''}`}
            selected={filter === 'past'}
            onPress={() => setFilter('past')}
          />
        </View>
      }
      ListEmptyComponent={
        <View className="pt-14">
          {filter === 'upcoming' ? (
            <EmptyState
              icon="ticket-outline"
              title="No upcoming bookings"
              message="When you book something, it'll show up here with your ticket."
              action={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Browse events"
                  onPress={() => {
                    haptics.tap();
                    router.push('/(tabs)');
                  }}
                  className="mt-2 rounded-md bg-action-primary px-4 py-2.5 active:opacity-80"
                >
                  <Text variant="subhead" tone="onAccent" className="font-semibold">
                    Browse events
                  </Text>
                </Pressable>
              }
            />
          ) : (
            <EmptyState
              icon="time-outline"
              title="Nothing here yet"
              message="Events you've already been to will appear here."
            />
          )}
        </View>
      }
    />
  );
}

function BookingCard({ booking }: { booking: Booking }) {
  const router = useRouter();
  const { colors } = useTheme();
  const tone = bookingTone(booking.status);
  const count = booking._count.tickets;
  const total = formatMoney(booking.totalMinor, booking.currency);
  const when = formatDateTime(booking.eventSession.startsAt);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        booking.event.title,
        when,
        `${count} ${count === 1 ? 'ticket' : 'tickets'}`,
        total,
        booking.status.toLowerCase(),
        booking.reference ? `reference ${booking.reference}` : null,
      ]
        .filter(Boolean)
        .join('. ')}
      accessibilityHint="Opens the booking and its tickets"
      onPress={() => {
        haptics.tap();
        router.push({ pathname: '/booking/[id]', params: { id: booking.id } });
      }}
      className="mx-5 mb-3 flex-row items-center gap-3 rounded-md border border-border bg-background-surface p-4 active:opacity-70"
    >
      <View className="flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text variant="headline" numberOfLines={1} className="flex-1">
            {booking.event.title}
          </Text>
          <Badge label={booking.status} tone={tone} />
        </View>
        <Text variant="footnote" tone="muted">
          {when}
        </Text>
        <Text variant="footnote" tone="muted">
          {count} {count === 1 ? 'ticket' : 'tickets'} · {total}
        </Text>
        {booking.reference ? (
          <Text variant="caption" tone="muted">
            {booking.reference}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}
