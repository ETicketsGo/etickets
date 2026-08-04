import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '@/components/screen';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { Badge, Card, IconButton, Separator, Text } from '@/ui';
import { formatDateTime, formatMoney } from '@/services/locale';
import { useBookings } from '@/features/bookings/api';
import { useOfflineTickets } from '@/features/bookings/use-offline-tickets';
import { OfflineTicketNotice } from '@/features/bookings/offline-notice';
import { bookingTone } from '@/features/bookings/schema';
import type { CachedTicket } from '@/services/ticket-cache';
import { TicketQr } from '@/features/bookings/ticket-qr';

/**
 * A single booking and the tickets in it.
 *
 * This is also where checkout lands after payment, and where the payment deep link
 * returns to. It deliberately re-reads the booking from the API rather than trusting
 * anything the payment flow said: a browser returning to the app proves the browser
 * closed, not that the charge settled, and the server's status is the only fact.
 */
export default function BookingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const online = useOnline();

  const bookings = useBookings();
  const tickets = useOfflineTickets();

  const booking = useMemo(() => bookings.data?.data.find((b) => b.id === id), [bookings.data, id]);
  const bookingTickets = useMemo(
    () => tickets.tickets.filter((t) => t.bookingId === id),
    [tickets.tickets, id],
  );

  const loading = bookings.isPending || tickets.loading;

  return (
    <Screen padded={false} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      {!online ? <OfflineBanner /> : null}

      <View className="flex-row items-center gap-1 px-2 py-1">
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Go back"
          // replace() lands here from checkout, so there may be nothing to go back to.
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/tickets'))}
        />
        <Text variant="callout" className="flex-1 font-semibold">
          Your booking
        </Text>
      </View>

      {loading ? (
        <LoadingState label="Loading your booking…" />
      ) : bookings.isError ? (
        <ErrorState
          title="Couldn't load this booking"
          message={online ? 'Please try again.' : "You're offline and this isn't saved yet."}
          onRetry={() => void bookings.refetch()}
        />
      ) : !booking ? (
        <EmptyState
          icon="help-circle-outline"
          title="Booking not found"
          message="It may belong to a different account, or it may have expired."
        />
      ) : (
        <ScrollView contentContainerClassName="gap-5 px-5 pb-8 pt-2">
          {tickets.fromCache ? (
            <OfflineTicketNotice syncedAt={tickets.syncedAt} stale={tickets.stale} />
          ) : null}
          <View className="gap-1">
            <Badge label={booking.status} tone={bookingTone(booking.status)} />
            <Text variant="title2" accessibilityRole="header">
              {booking.event.title}
            </Text>
            <Text variant="subhead" tone="muted">
              {formatDateTime(booking.eventSession.startsAt)}
            </Text>
          </View>

          {booking.status.toUpperCase() === 'PENDING_PAYMENT' ? (
            <Card>
              <Text variant="headline">Payment not completed</Text>
              <Text variant="subhead" tone="muted" className="mt-1">
                We haven&rsquo;t received payment for this booking yet. If you just paid, give it a
                moment and pull to refresh — confirmation can take a few seconds.
              </Text>
            </Card>
          ) : null}

          <Card className="gap-2">
            <Row label="Reference" value={booking.reference ?? 'Issued on confirmation'} />
            <Separator />
            <Row label="Tickets" value={String(booking._count.tickets)} />
            <Separator />
            <Row label="Paid" value={formatMoney(booking.totalMinor, booking.currency)} />
            <Separator />
            <Row label="Booked by" value={booking.buyerName} />
          </Card>

          {bookingTickets.length > 0 ? (
            <View className="gap-3">
              <Text variant="title3" accessibilityRole="header">
                {bookingTickets.length === 1 ? 'Your ticket' : 'Your tickets'}
              </Text>
              {bookingTickets.map((t) => (
                <TicketCard key={t.id} ticket={t} />
              ))}
            </View>
          ) : booking.status.toUpperCase() === 'CONFIRMED' ? (
            <Card>
              <Text variant="subhead" tone="muted">
                Your tickets are being issued. They&rsquo;ll appear here shortly.
              </Text>
            </Card>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

function TicketCard({ ticket }: { ticket: CachedTicket }) {
  const where = [ticket.venueName, ticket.cinemaName, ticket.screenName]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card className="items-center gap-3">
      <View className="w-full gap-0.5">
        <Text variant="headline">{ticket.ticketType}</Text>
        {ticket.seatLabel ? (
          <Text variant="subhead" tone="secondary">
            Seat {ticket.seatLabel}
          </Text>
        ) : null}
        {where ? (
          <Text variant="footnote" tone="muted">
            {where}
          </Text>
        ) : null}
        {ticket.attendeeName ? (
          <Text variant="footnote" tone="muted">
            {ticket.attendeeName}
          </Text>
        ) : null}
      </View>

      <TicketQr ticket={ticket} />

      <View className="w-full flex-row items-center justify-between">
        <Text variant="caption" tone="muted">
          {ticket.serial}
        </Text>
        <Badge
          label={ticket.status}
          tone={ticket.status.toUpperCase() === 'VALID' ? 'success' : 'neutral'}
        />
      </View>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text variant="subhead" tone="secondary">
        {label}
      </Text>
      <Text variant="subhead" className="flex-1 text-right" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}
