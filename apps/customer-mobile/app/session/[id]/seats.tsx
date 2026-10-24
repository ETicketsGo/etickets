import { useCallback, useMemo, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '@/components/screen';
import { TopBar } from '@/components/top-bar';
import { BookingBar } from '@/components/booking-bar';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { Badge, Button, IconButton, Text, haptics } from '@/ui';
import { formatMoney } from '@/services/locale';
import { messageForError } from '@/services/errors';
import { useEvent } from '@/features/events/api';
import {
  SEAT_SELECTION_ON_WEBSITE,
  SeatSelectionUnavailableError,
} from '@/features/events/seating';
import {
  findSeatConflicts,
  maxSelectableSeats,
  selectionTotalMinor,
  toBookingItems,
  useSeatMap,
} from '@/features/cinema/api';
import { SeatMapView } from '@/features/cinema/seat-map-view';
import { SeatListView } from '@/features/cinema/seat-list-view';
import { SeatLegend } from '@/features/cinema/seat-legend';
import { SEAT_STATE_LABEL } from '@/features/cinema/seat-colors';
import { seatName, seatVisualState, type Seat } from '@/features/cinema/schema';

/**
 * Reserved-seat selection for one screening.
 *
 * The rule this screen is built around: the SERVER owns seat state. Selection here is
 * purely local intent — nothing is reserved until POST /bookings succeeds, and the map
 * is re-read and re-checked immediately before that call. A seat looking green on this
 * device has never meant it is yours.
 */
export default function SeatSelectionScreen() {
  const { id: sessionId } = useLocalSearchParams<{ id: string }>();
  const { slug } = useLocalSearchParams<{ slug?: string }>();
  const router = useRouter();
  const online = useOnline();

  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'map' | 'list'>('map');
  const [checking, setChecking] = useState(false);

  const { data: event } = useEvent(slug ?? '');
  const session = event?.sessions.find((s) => s.id === sessionId);
  const {
    data: map,
    error,
    isPending,
    isError,
    refetch,
    isRefetching,
  } = useSeatMap(sessionId ?? '');
  // A sectioned venue map the app cannot draw: say where to choose seats, not "try again".
  const onWebsiteOnly = error instanceof SeatSelectionUnavailableError;

  // The seat map carries prices but no currency; the session's ticket types do. INR is
  // the fallback only until the session loads — prices render from the same map either way.
  const currency = session?.ticketTypes[0]?.currency ?? 'INR';
  const maxSeats = useMemo(
    () => maxSelectableSeats((session?.ticketTypes ?? []).map((t) => t.maxPerOrder)),
    [session],
  );

  const totalMinor = useMemo(
    () => (map ? selectionTotalMinor(map, selectedSeatIds) : 0),
    [map, selectedSeatIds],
  );

  const selectedNames = useMemo(() => {
    if (!map) return [];
    const names: string[] = [];
    for (const section of map.sections)
      for (const row of section.rows)
        for (const seat of row.seats)
          if (selectedSeatIds.includes(seat.id)) names.push(seatName(row.label, seat));
    return names;
  }, [map, selectedSeatIds]);

  const toggleSeat = useCallback(
    (seat: Seat, rowLabel: string) => {
      setSelectedSeatIds((current) => {
        if (current.includes(seat.id)) {
          haptics.select();
          return current.filter((id) => id !== seat.id);
        }
        if (current.length >= maxSeats) {
          haptics.warning();
          Alert.alert(
            'Seat limit reached',
            `You can book up to ${maxSeats} seats in one order. Deselect a seat to choose a different one.`,
          );
          return current;
        }
        haptics.select();
        return [...current, seat.id];
      });
    },
    [maxSeats],
  );

  /** Tapping a seat you cannot have should say why, not do nothing. */
  const explainBlocked = useCallback(
    (seat: Seat, rowLabel: string) => {
      const category = map?.categories.find((c) => c.id === seat.categoryId);
      const state = seatVisualState(seat, category, false);
      haptics.warning();
      Alert.alert(
        `Seat ${seatName(rowLabel, seat)}`,
        state === 'held'
          ? 'Someone else is checking out with this seat right now. It may free up if they do not finish.'
          : state === 'sold'
            ? 'This seat has already been sold.'
            : 'This seat is not on sale for this screening.',
      );
    },
    [map],
  );

  /**
   * Re-read the map and verify the selection before creating the booking.
   *
   * Without this the user learns their seat went five minutes ago from a rejected
   * booking that names nothing. With it they get "B7 is now sold" and a selection with
   * the dead seats removed, which is recoverable in one tap.
   */
  const onContinue = async () => {
    if (!map || selectedSeatIds.length === 0 || !sessionId) return;
    setChecking(true);
    try {
      const { data: fresh } = await refetch();
      if (!fresh) throw new Error('Could not re-check seat availability.');

      const conflicts = findSeatConflicts(fresh, selectedSeatIds);
      if (conflicts.length > 0) {
        const lost = new Set(conflicts.map((c) => c.seatId));
        setSelectedSeatIds((current) => current.filter((id) => !lost.has(id)));
        haptics.error();
        Alert.alert(
          conflicts.length === 1 ? 'A seat was just taken' : 'Some seats were just taken',
          `${conflicts
            .map((c) => `${c.name} is now ${describeConflict(c.status)}`)
            .join(
              '. ',
            )}. We have removed ${conflicts.length === 1 ? 'it' : 'them'}. Please pick again.`,
        );
        return;
      }

      const items = toBookingItems(fresh, selectedSeatIds);
      if (items.length === 0) throw new Error('These seats cannot be booked right now.');

      router.push({
        pathname: '/checkout',
        params: {
          sessionId,
          slug: slug ?? '',
          items: JSON.stringify(items),
          seatNames: selectedNames.join(', '),
        },
      });
    } catch (err) {
      Alert.alert('Could not continue', messageForError(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Screen padded={false} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <TopBar
        title={event ? event.title : 'Choose your seats'}
        right={
          <IconButton
            icon={mode === 'map' ? 'list-outline' : 'grid-outline'}
            tone="outlined"
            size={20}
            accessibilityLabel={
              mode === 'map' ? 'Switch to seat list view' : 'Switch to seat map view'
            }
            onPress={() => setMode((m) => (m === 'map' ? 'list' : 'map'))}
          />
        }
      />
      {!online ? <OfflineBanner /> : null}

      {isPending ? (
        <LoadingState label="Loading seats..." />
      ) : onWebsiteOnly ? (
        <ErrorState title="Choose seats on the website" message={SEAT_SELECTION_ON_WEBSITE} />
      ) : isError || !map ? (
        <ErrorState
          title="We could not load the seat map"
          message={
            online ? 'Please try again.' : 'You are offline. Seat availability needs a connection.'
          }
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          <ScrollView contentContainerClassName="gap-4 px-4 pb-6 pt-1">
            <View className="gap-1">
              <Text variant="d2" accessibilityRole="header">
                Choose your seats
              </Text>
              <View className="flex-row items-center justify-between">
                <Text variant="ui" tone="muted">
                  Up to {maxSeats} seats per order
                </Text>
                {isRefetching ? <Badge label="Refreshing..." tone="neutral" /> : null}
              </View>
            </View>

            {mode === 'map' ? (
              <View className="gap-4 overflow-hidden rounded-card bg-stage px-1 pb-5 pt-2">
                <SeatMapView
                  map={map}
                  selectedSeatIds={selectedSeatIds}
                  onToggleSeat={toggleSeat}
                  onSeatBlocked={explainBlocked}
                />
                <View className="px-3">
                  <SeatLegend categories={map.categories} currency={currency} />
                </View>
              </View>
            ) : (
              <SeatListView
                map={map}
                selectedSeatIds={selectedSeatIds}
                onToggleSeat={toggleSeat}
                currency={currency}
              />
            )}

            <Button
              label="Refresh availability"
              variant="secondary"
              icon="refresh"
              fullWidth={false}
              onPress={() => void refetch()}
            />
          </ScrollView>

          <BookingBar>
            <View className="flex-row items-center gap-4" accessibilityLiveRegion="polite">
              <View className="flex-1">
                <Text variant="meta" tone="muted" numberOfLines={1}>
                  {selectedSeatIds.length === 0
                    ? 'No seats selected'
                    : `Seats ${selectedNames.join(', ')}`}
                </Text>
                <Text variant="figureSm">
                  {selectedSeatIds.length > 0 ? formatMoney(totalMinor, currency) : '-'}
                </Text>
              </View>
              <Button
                label="Continue"
                size="lg"
                fullWidth={false}
                disabled={selectedSeatIds.length === 0 || !online}
                loading={checking}
                onPress={() => void onContinue()}
              />
            </View>
          </BookingBar>
        </>
      )}
    </Screen>
  );
}

/**
 * Plain wording for why a seat was lost between selecting it and continuing. Falls
 * through to a neutral phrase so an unrecognised server state still reads as English.
 */
function describeConflict(status: string): string {
  switch (status) {
    case 'SOLD':
      return SEAT_STATE_LABEL.sold;
    case 'HELD':
      return SEAT_STATE_LABEL.held;
    case 'REMOVED':
      return 'no longer on this screen';
    default:
      return SEAT_STATE_LABEL.unavailable;
  }
}
