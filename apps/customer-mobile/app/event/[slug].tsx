import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/components/screen';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useTheme } from '@/theme';
import { Badge, Button, Card, Chip, IconButton, Separator, Text } from '@/ui';
import { formatDateTime, formatMoney } from '@/services/locale';
import { useEvent } from '@/features/events/api';
import { QuantityStepper } from '@/features/events/quantity-stepper';
import type { EventSession, TicketType } from '@/features/events/schema';

/**
 * Event detail and ticket selection.
 *
 * The running total shown here is the ticket subtotal ONLY, and says so. Platform and
 * payment fees depend on the event's feeMode and on the payment route the backend
 * picks, so the amount that will actually be charged is the API's quote at checkout.
 * Showing a confident "Total" here that later changes is worse than showing a subtotal
 * that was always labelled as one.
 */
export default function EventDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const online = useOnline();
  const { colors } = useTheme();
  const { data: event, isPending, isError, refetch } = useEvent(slug ?? '');

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const session: EventSession | undefined = useMemo(() => {
    if (!event?.sessions.length) return undefined;
    return event.sessions.find((s) => s.id === sessionId) ?? event.sessions[0];
  }, [event, sessionId]);

  const selected = useMemo(
    () =>
      (session?.ticketTypes ?? [])
        .map((t) => ({ type: t, qty: quantities[t.id] ?? 0 }))
        .filter((r) => r.qty > 0),
    [session, quantities],
  );

  const totalQty = selected.reduce((n, r) => n + r.qty, 0);
  const subtotalMinor = selected.reduce((n, r) => n + r.type.priceMinor * r.qty, 0);
  const currency = session?.ticketTypes[0]?.currency ?? 'INR';

  if (isPending) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: false }} />
        <LoadingState label="Loading event…" />
      </Screen>
    );
  }

  if (isError || !event) {
    return (
      <Screen>
        <ErrorState
          title="Couldn't load this event"
          message={online ? 'Please try again.' : "You're offline. Reconnect and try again."}
          onRetry={() => void refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen padded={false} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      {!online ? <OfflineBanner /> : null}

      <View className="flex-row items-center gap-1 px-2 py-1">
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
        />
        <Text variant="callout" numberOfLines={1} className="flex-1 font-semibold">
          {event.title}
        </Text>
      </View>

      <ScrollView contentContainerClassName="pb-6" showsVerticalScrollIndicator={false}>
        <View className="gap-2 px-5 pb-4">
          <Badge label={event.category} tone="accent" />
          <Text variant="title1" accessibilityRole="header">
            {event.title}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <Ionicons name="location-outline" size={15} color={colors.textMuted} />
            <Text variant="subhead" tone="muted" className="flex-1">
              {event.venue.name}, {event.venue.city}
            </Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <Ionicons name="person-outline" size={15} color={colors.textMuted} />
            <Text variant="subhead" tone="muted">
              {event.organizer.name}
            </Text>
          </View>
        </View>

        {event.description ? (
          <View className="px-5 pb-5">
            <Text variant="body" tone="secondary">
              {event.description}
            </Text>
          </View>
        ) : null}

        {event.sessions.length === 0 ? (
          <Card className="mx-5">
            <Text variant="headline">No dates scheduled</Text>
            <Text variant="subhead" tone="muted" className="mt-1">
              Tickets aren&rsquo;t on sale for this event yet.
            </Text>
          </Card>
        ) : (
          <>
            {event.sessions.length > 1 ? (
              <View className="gap-2 px-5 pb-5">
                <Text variant="title3" accessibilityRole="header">
                  Choose a date
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerClassName="gap-2"
                >
                  {event.sessions.map((s) => (
                    <Chip
                      key={s.id}
                      label={formatDateTime(s.startsAt)}
                      selected={session?.id === s.id}
                      onPress={() => {
                        setSessionId(s.id);
                        // Quantities are per ticket-type and ticket-type ids differ per
                        // session, so carrying them across would silently keep a
                        // selection for tickets that are not on this date.
                        setQuantities({});
                      }}
                    />
                  ))}
                </ScrollView>
              </View>
            ) : session ? (
              <View className="px-5 pb-5">
                <Text variant="subhead" tone="secondary">
                  {formatDateTime(session.startsAt)}
                </Text>
              </View>
            ) : null}

            <View className="gap-3 px-5">
              <Text variant="title3" accessibilityRole="header">
                Tickets
              </Text>
              <Card padded={false}>
                {(session?.ticketTypes ?? []).map((t, i) => (
                  <View key={t.id}>
                    {i > 0 ? <Separator /> : null}
                    <TicketTypeRow
                      ticketType={t}
                      quantity={quantities[t.id] ?? 0}
                      onChange={(q) => setQuantities((cur) => ({ ...cur, [t.id]: q }))}
                    />
                  </View>
                ))}
              </Card>
            </View>

            {event.refundPolicy ? (
              <View className="gap-1 px-5 pt-6">
                <Text variant="footnote" tone="muted" className="uppercase">
                  Refund policy
                </Text>
                <Text variant="subhead" tone="secondary">
                  {event.refundPolicy}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      {totalQty > 0 && session ? (
        <View className="border-t border-border bg-background-surface px-5 pb-2 pt-3">
          <View className="mb-2 flex-row items-end justify-between">
            <View>
              <Text variant="footnote" tone="muted">
                {totalQty} {totalQty === 1 ? 'ticket' : 'tickets'} · subtotal
              </Text>
              <Text variant="title3">{formatMoney(subtotalMinor, currency)}</Text>
            </View>
            <Text variant="caption" tone="muted" className="max-w-[52%] text-right">
              Fees and the final total are confirmed at checkout.
            </Text>
          </View>
          <Button
            label="Continue"
            size="lg"
            icon="arrow-forward"
            onPress={() =>
              router.push({
                pathname: '/checkout',
                params: {
                  eventId: event.id,
                  sessionId: session.id,
                  slug: event.slug,
                  // Serialised because Expo Router params are strings; the checkout
                  // screen re-reads authoritative prices from the API regardless.
                  items: JSON.stringify(
                    selected.map((r) => ({ ticketTypeId: r.type.id, quantity: r.qty })),
                  ),
                },
              })
            }
          />
        </View>
      ) : null}
    </Screen>
  );
}

function TicketTypeRow({
  ticketType,
  quantity,
  onChange,
}: {
  ticketType: TicketType;
  quantity: number;
  onChange: (q: number) => void;
}) {
  const soldOut = ticketType.available <= 0;
  // Whichever runs out first: what is left, or what one order is allowed to contain.
  const max = Math.min(ticketType.maxPerOrder, ticketType.available);
  const lowStock = !soldOut && ticketType.available <= 10;

  return (
    <View className="flex-row items-center gap-3 p-4">
      <View className="flex-1 gap-0.5">
        <Text variant="headline">{ticketType.name}</Text>
        <Text variant="subhead" tone="secondary">
          {formatMoney(ticketType.priceMinor, ticketType.currency)}
        </Text>
        {soldOut ? (
          <Badge label="Sold out" tone="error" className="mt-1" />
        ) : lowStock ? (
          <Badge label={`Only ${ticketType.available} left`} tone="warning" className="mt-1" />
        ) : null}
      </View>
      {soldOut ? null : (
        <QuantityStepper
          value={quantity}
          onChange={onChange}
          max={max}
          label={`${ticketType.name} tickets`}
        />
      )}
    </View>
  );
}
