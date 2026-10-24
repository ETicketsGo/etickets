import { useMemo } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '@/components/screen';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { Badge, Card, IconButton, Separator, Text } from '@/ui';
import { formatDateTime, formatMoney } from '@/services/locale';
import { useBooking } from '@/features/bookings/api';
import { useOfflineTickets } from '@/features/bookings/use-offline-tickets';
import { OfflineTicketNotice } from '@/features/bookings/offline-notice';
import { bookingStatusLabel, bookingTone, ticketState } from '@/features/bookings/schema';
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

  const bookingQuery = useBooking(id ?? '');
  const tickets = useOfflineTickets();

  const booking = bookingQuery.data;
  const pending = booking?.status.toUpperCase() === 'PENDING_PAYMENT';
  // True while the screen is still re-reading the booking by itself.
  const waitingForConfirmation = pending && bookingQuery.polling;
  const bookingTickets = useMemo(
    () => tickets.tickets.filter((t) => t.bookingId === id),
    [tickets.tickets, id],
  );

  // Offline, React Query PAUSES the request rather than failing it, so it would stay
  // "pending" for ever and the screen would spin until signal returned.
  const paused = bookingQuery.isPending && bookingQuery.fetchStatus === 'paused';
  const unreachable = bookingQuery.isError || paused;
  // The booking itself cannot be read, but tickets saved on this device can still be
  // shown. Someone at a venue with no signal needs the code, not an error.
  const offlineOnly = unreachable && bookingTickets.length > 0;
  const loading = (bookingQuery.isPending && !paused) || tickets.loading;

  const refresh = () => {
    void bookingQuery.refetch();
    tickets.refetch();
  };

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
      ) : offlineOnly ? (
        <ScrollView contentContainerClassName="gap-5 px-5 pb-8 pt-2">
          <OfflineTicketNotice syncedAt={tickets.syncedAt} stale={tickets.stale} />
          <View className="gap-3">
            {bookingTickets.map((t) => (
              <TicketCard key={t.id} ticket={t} />
            ))}
          </View>
        </ScrollView>
      ) : unreachable ? (
        <ErrorState
          title="Couldn't load this booking"
          message={online ? 'Please try again.' : "You're offline and this isn't saved yet."}
          onRetry={() => void bookingQuery.refetch()}
        />
      ) : !booking ? (
        <EmptyState
          icon="help-circle-outline"
          title="Booking not found"
          message="It may belong to a different account, or it may have expired."
        />
      ) : (
        <ScrollView
          contentContainerClassName="gap-5 px-5 pb-8 pt-2"
          refreshControl={
            <RefreshControl refreshing={bookingQuery.isRefetching} onRefresh={refresh} />
          }
        >
          {tickets.fromCache ? (
            <OfflineTicketNotice syncedAt={tickets.syncedAt} stale={tickets.stale} />
          ) : null}
          <View className="gap-1">
            <Badge label={bookingStatusLabel(booking.status)} tone={bookingTone(booking.status)} />
            <Text variant="title2" accessibilityRole="header">
              {booking.event.title}
            </Text>
            <Text variant="subhead" tone="muted">
              {formatDateTime(booking.eventSession.startsAt)}
            </Text>
          </View>

          {pending ? (
            <Card>
              <Text variant="headline">Waiting for payment</Text>
              <Text variant="subhead" tone="muted" className="mt-1">
                {waitingForConfirmation
                  ? 'If you paid, we are waiting for your bank to confirm. This page updates by itself. It usually takes a few seconds.'
                  : 'We have not received payment for this booking. If you paid, pull down to check again.'}
              </Text>
            </Card>
          ) : null}

          <Card className="gap-2">
            {booking.reference ? (
              <>
                <Row label="Reference" value={booking.reference} />
                <Separator />
              </>
            ) : null}
            <Row label="Tickets" value={String(booking.tickets.length)} />
            <Separator />
            <Row
              label={pending ? 'Total' : 'Paid'}
              value={formatMoney(booking.totalMinor, booking.currency)}
            />
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
  const state = ticketState(ticket.status);
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

      {state.showCode ? (
        <TicketQr ticket={ticket} />
      ) : (
        <Text variant="subhead" tone="muted" className="text-center">
          {state.label === 'Checked in'
            ? 'This ticket has been used to enter.'
            : 'This ticket cannot be used to enter.'}
        </Text>
      )}

      <View className="w-full flex-row items-center justify-between">
        <Text variant="caption" tone="muted">
          {ticket.serial}
        </Text>
        <Badge label={state.label} tone={state.tone} />
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
