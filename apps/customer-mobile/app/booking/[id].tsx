import { useEffect, useMemo } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '@/components/screen';
import { TopBar } from '@/components/top-bar';
import { askForPushAfterBooking } from '@/services/push-registration';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { Badge, Card, Eyebrow, Text } from '@/ui';
import { formatEventWhen, formatMoney } from '@/services/locale';
import { useBooking } from '@/features/bookings/api';
import { useOfflineTickets } from '@/features/bookings/use-offline-tickets';
import { OfflineTicketNotice } from '@/features/bookings/offline-notice';
import { bookingStatusLabel, bookingTone, ticketState } from '@/features/bookings/schema';
import type { CachedTicket } from '@/services/ticket-cache';
import { TicketQr } from '@/features/bookings/ticket-qr';
import { BookingManage } from '@/features/bookings/booking-manage';

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
  const confirmed = booking?.status.toUpperCase() === 'CONFIRMED';
  // The moment a person sees why updates matter: their first confirmed booking. Asked once.
  useEffect(() => {
    if (confirmed) void askForPushAfterBooking();
  }, [confirmed]);
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

      <TopBar
        title="Your booking"
        // replace() lands here from checkout, so there may be nothing to go back to.
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/tickets'))}
      />

      {loading ? (
        <LoadingState label="Loading your booking..." />
      ) : offlineOnly ? (
        <ScrollView contentContainerClassName="gap-5 px-4 pb-10 pt-2">
          <OfflineTicketNotice syncedAt={tickets.syncedAt} stale={tickets.stale} />
          {bookingTickets.map((t) => (
            <TicketPass key={t.id} ticket={t} />
          ))}
        </ScrollView>
      ) : unreachable ? (
        <ErrorState
          title="We could not load this booking"
          message={online ? 'Please try again.' : 'You are offline and this is not saved yet.'}
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
          contentContainerClassName="gap-6 px-4 pb-10 pt-2"
          refreshControl={
            <RefreshControl refreshing={bookingQuery.isRefetching} onRefresh={refresh} />
          }
        >
          {tickets.fromCache ? (
            <OfflineTicketNotice syncedAt={tickets.syncedAt} stale={tickets.stale} />
          ) : null}

          <View className="gap-2">
            <Badge label={bookingStatusLabel(booking.status)} tone={bookingTone(booking.status)} />
            <Text variant="d1" accessibilityRole="header">
              {booking.event.title}
            </Text>
            <Text variant="body" tone="secondary">
              <Text variant="body" className="font-semibold">
                {formatEventWhen(booking.eventSession.startsAt, booking.timeZone ?? undefined)}
              </Text>
              {booking.event.venue?.name
                ? ` - ${booking.event.venue.name}${booking.event.venue.city ? `, ${booking.event.venue.city}` : ''}`
                : ''}
            </Text>
          </View>

          {pending ? (
            <Card tone="sunken" className="gap-1">
              <Text variant="card">Waiting for payment</Text>
              <Text variant="ui" tone="secondary">
                {waitingForConfirmation
                  ? 'If you paid, we are waiting for your bank to confirm. This page updates by itself. It usually takes a few seconds.'
                  : 'We have not received payment for this booking. If you paid, pull down to check again.'}
              </Text>
            </Card>
          ) : null}

          {bookingTickets.length > 0 ? (
            <View className="gap-4">
              {bookingTickets.map((t) => (
                <TicketPass key={t.id} ticket={t} timeZone={booking.timeZone ?? undefined} />
              ))}
            </View>
          ) : booking.status.toUpperCase() === 'CONFIRMED' ? (
            <Card tone="sunken">
              <Text variant="ui" tone="secondary">
                Your tickets are being issued. They will appear here shortly.
              </Text>
            </Card>
          ) : null}

          <BookingManage booking={booking} />

          <Card className="gap-3 p-5">
            <Eyebrow>Booking details</Eyebrow>
            {booking.reference ? <Row label="Reference" value={booking.reference} /> : null}
            <Row label="Tickets" value={String(booking.tickets.length)} />
            <Row
              label={pending ? 'Total' : 'Paid'}
              value={formatMoney(booking.totalMinor, booking.currency)}
            />
            <Row label="Booked by" value={booking.buyerName} />
          </Card>
        </ScrollView>
      )}
    </Screen>
  );
}

/**
 * A ticket as a pass: a stage card (the storefront's dark band), the event and the seat at
 * the top, the server-rendered code on a white plate, a perforation, then the serial and
 * the ticket's state. Only an ACTIVE ticket shows its code.
 */
function TicketPass({ ticket, timeZone }: { ticket: CachedTicket; timeZone?: string }) {
  const state = ticketState(ticket.status);
  const where = [ticket.venueName, ticket.cinemaName, ticket.screenName]
    .filter(Boolean)
    .join(' - ');

  return (
    <View className="overflow-hidden rounded-card bg-stage">
      <View className="gap-1 px-5 pb-4 pt-5">
        <Text variant="eyebrow" tone="goldOnStage">
          {ticket.ticketType}
        </Text>
        <Text variant="d3" tone="onStage" numberOfLines={2}>
          {ticket.event.title}
        </Text>
        <Text variant="meta" tone="onStage2">
          {formatEventWhen(ticket.startsAt, ticket.timezone ?? timeZone)}
          {where ? ` - ${where}` : ''}
        </Text>
        {ticket.seatLabel ? (
          <View className="mt-2 flex-row items-baseline gap-2">
            <Text variant="eyebrow" tone="onStage3">
              Seat
            </Text>
            <Text variant="figureSm" tone="onStage">
              {ticket.seatLabel}
            </Text>
          </View>
        ) : null}
        {ticket.attendeeName ? (
          <Text variant="meta" tone="onStage3">
            {ticket.attendeeName}
          </Text>
        ) : null}
      </View>

      <View className="items-center px-5 pb-5">
        {state.showCode ? (
          <TicketQr ticket={ticket} />
        ) : (
          <View className="w-full items-center rounded-control bg-stage-surface px-4 py-8">
            <Text variant="ui" tone="onStage2" className="text-center">
              {state.label === 'Checked in'
                ? 'This ticket has been used to enter.'
                : 'This ticket cannot be used to enter.'}
            </Text>
          </View>
        )}
      </View>

      {/* The perforation: two notches and a dashed rule, as a paper ticket has. */}
      <View className="flex-row items-center">
        <View className="-ml-3 h-6 w-6 rounded-full bg-paper" />
        <View className="flex-1 border-t border-dashed border-stage-line-strong" />
        <View className="-mr-3 h-6 w-6 rounded-full bg-paper" />
      </View>

      <View className="flex-row items-center justify-between px-5 pb-5 pt-3">
        <Text variant="meta" tone="onStage3" tabular>
          {ticket.serial}
        </Text>
        <View
          className={`rounded-full px-2.5 py-0.5 ${
            state.tone === 'success' ? 'bg-gold-on-ink' : 'bg-stage-sunken'
          }`}
        >
          <Text
            variant="meta"
            tone={state.tone === 'success' ? 'primary' : 'onStage2'}
            className="font-semibold"
          >
            {state.label}
          </Text>
        </View>
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text variant="ui" tone="secondary">
        {label}
      </Text>
      <Text variant="ui" className="flex-1 text-right font-medium" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}
