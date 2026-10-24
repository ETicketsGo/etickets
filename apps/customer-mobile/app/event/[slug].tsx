import { useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, Share, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/components/screen';
import { TopBar } from '@/components/top-bar';
import { BookingBar } from '@/components/booking-bar';
import { ErrorState, OfflineBanner, Skeleton } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { palette } from '@/theme';
import { Button, Card, Eyebrow, GoldRule, IconButton, Separator, Text, haptics } from '@/ui';
import { formatEventWhen, formatMoney, formatShortDate, formatShortTime } from '@/services/locale';
import { env } from '@/services/env';
import { useEvent } from '@/features/events/api';
import { QuantityStepper } from '@/features/events/quantity-stepper';
import { EventPicture } from '@/features/events/event-picture';
import { ContentLabelPill } from '@/features/events/content-label';
import {
  isOnSale,
  type EventDetail,
  type EventSession,
  type TicketType,
} from '@/features/events/schema';
import { requiresSeatSelection } from '@/features/events/seating';

/**
 * Event page and ticket selection, laid out as the storefront's event page on a phone: the
 * title block, the picture, the facts grid, the story, then "Choose your tickets", with a
 * sticky booking bar.
 *
 * The figure in the bar is the ticket SUBTOTAL and says so. Fees depend on the event's fee
 * mode and the payment route the server picks, so the amount charged is the server's quote
 * at checkout, shown there before anything is held.
 */
export default function EventDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const online = useOnline();
  const { data: event, isPending, isError, refetch } = useEvent(slug ?? '');
  const scroll = useRef<ScrollView>(null);
  const [panelY, setPanelY] = useState(0);

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

  /**
   * Booked by choosing seats is a fact about the session, not the kind of event: a seated
   * theatre show is an EVENT. The server's `seatBased` answers; only an older API without it
   * falls back to the experience type.
   */
  const reservedSeating = requiresSeatSelection(session, event?.experienceType);

  const totalQty = selected.reduce((n, r) => n + r.qty, 0);
  const subtotalMinor = selected.reduce((n, r) => n + r.type.priceMinor * r.qty, 0);
  const currency = session?.ticketTypes[0]?.currency ?? 'INR';
  const fromMinor = useMemo(() => {
    const prices = (session?.ticketTypes ?? []).filter(isOnSale).map((t) => t.priceMinor);
    return prices.length ? Math.min(...prices) : null;
  }, [session]);

  if (isPending) return <EventSkeleton />;

  if (isError || !event) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: false }} />
        <TopBar />
        <ErrorState
          title="We could not load this event"
          message={online ? 'Please try again.' : 'You are offline. Reconnect and try again.'}
          onRetry={() => void refetch()}
        />
      </Screen>
    );
  }

  const tz = event.timeZone ?? undefined;
  const toTickets = () => scroll.current?.scrollTo({ y: Math.max(panelY - 12, 0), animated: true });

  const goToCheckout = () => {
    if (!session) return;
    router.push({
      pathname: '/checkout',
      params: {
        eventId: event.id,
        sessionId: session.id,
        slug: event.slug,
        // Serialised because route params are strings; checkout re-reads prices from the API.
        items: JSON.stringify(selected.map((r) => ({ ticketTypeId: r.type.id, quantity: r.qty }))),
      },
    });
  };
  const goToSeats = () => {
    if (!session) return;
    router.push({ pathname: '/session/[id]/seats', params: { id: session.id, slug: event.slug } });
  };

  return (
    <Screen padded={false} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <TopBar
        right={
          <IconButton
            icon="share-outline"
            accessibilityLabel="Share this event"
            tone="outlined"
            size={20}
            onPress={() => void shareEvent(event)}
          />
        }
      />
      {!online ? <OfflineBanner /> : null}

      <ScrollView
        ref={scroll}
        contentContainerClassName="pb-10"
        showsVerticalScrollIndicator={false}
      >
        <TitleBlock event={event} session={session} fromMinor={fromMinor} currency={currency} />

        <View className="px-4">
          <EventPicture event={event} use="banner" fallback={null} className="rounded-card" />
        </View>

        {session ? <FactsGrid event={event} session={session} /> : null}

        {event.description ? (
          <View className="gap-3 px-4 pt-8">
            <Text variant="d2" accessibilityRole="header">
              About this event
            </Text>
            <Text variant="body" tone="secondary">
              {event.description}
            </Text>
          </View>
        ) : null}

        {event.artists && event.artists.length > 0 ? (
          <View className="gap-2 px-4 pt-8">
            <Eyebrow>Line-up</Eyebrow>
            <Text variant="body">{event.artists.map((a) => a.name).join(', ')}</Text>
          </View>
        ) : null}

        <View className="gap-4 px-4 pt-8">
          <Separator />
          <View className="gap-1.5">
            <Eyebrow>Venue</Eyebrow>
            <Text variant="card">{event.venue.name}</Text>
            <Text variant="ui" tone="secondary">
              {venueLine(event)}
            </Text>
            <Button
              label="Get directions"
              variant="secondary"
              icon="navigate-outline"
              fullWidth={false}
              className="mt-2"
              onPress={() => void openDirections(event)}
            />
          </View>
          <Separator />
          <View className="gap-1.5">
            <Eyebrow>Organizer</Eyebrow>
            <View className="flex-row items-center gap-1.5">
              <Text variant="card">{event.organizer.name}</Text>
              {event.organizer.verified ? (
                <Ionicons
                  name="checkmark-circle"
                  size={17}
                  color={palette.positive}
                  accessibilityLabel="Verified organizer"
                />
              ) : null}
            </View>
          </View>
          {event.refundPolicy ? (
            <>
              <Separator />
              <View className="gap-1.5">
                <Eyebrow>Refunds</Eyebrow>
                <Text variant="ui" tone="secondary">
                  {event.refundPolicy}
                </Text>
              </View>
            </>
          ) : null}
          {event.termsAndConditions ? (
            <>
              <Separator />
              <View className="gap-1.5">
                <Eyebrow>Terms</Eyebrow>
                <Text variant="ui" tone="secondary">
                  {event.termsAndConditions}
                </Text>
              </View>
            </>
          ) : null}
        </View>

        <View className="px-4 pt-10" onLayout={(e) => setPanelY(e.nativeEvent.layout.y)}>
          <Card className="gap-5 p-5">
            <View className="items-center gap-1.5">
              <Eyebrow>Reservation</Eyebrow>
              <Text variant="d3" accessibilityRole="header" className="text-center">
                {reservedSeating ? 'Choose your seats' : 'Choose your tickets'}
              </Text>
              {session ? (
                <Text variant="meta" tone="secondary" className="text-center">
                  {formatEventWhen(session.startsAt, tz)} - {event.venue.name}
                </Text>
              ) : null}
            </View>

            {event.sessions.length === 0 ? (
              <Text variant="ui" tone="secondary" className="text-center">
                Tickets are not on sale for this event yet.
              </Text>
            ) : (
              <>
                {event.sessions.length > 1 ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerClassName="gap-2"
                  >
                    {event.sessions.map((s) => (
                      <DateTile
                        key={s.id}
                        startsAt={s.startsAt}
                        timeZone={tz}
                        selected={session?.id === s.id}
                        onPress={() => {
                          setSessionId(s.id);
                          // Ticket-type ids differ per session, so a selection cannot carry over.
                          setQuantities({});
                        }}
                      />
                    ))}
                  </ScrollView>
                ) : null}

                {reservedSeating && session ? (
                  /*
                    Reserved seating: the ticket types are price CATEGORIES. A stepper would let
                    someone choose "3 Premium" without choosing which three, and the API requires
                    seat ids for a seated session, so seats are picked on the seat map.
                  */
                  <View className="gap-3">
                    {session.ticketTypes.map((t, i) => (
                      <View key={t.id}>
                        {i > 0 ? <Separator /> : null}
                        <View className="flex-row items-center justify-between py-2">
                          <Text variant="card">{t.name}</Text>
                          <Text variant="body" className="font-semibold" tabular>
                            {formatMoney(t.priceMinor, t.currency)}
                          </Text>
                        </View>
                      </View>
                    ))}
                    <Text variant="meta" tone="muted">
                      Pick your exact seats on the seat map.
                    </Text>
                  </View>
                ) : (
                  <View>
                    {(session?.ticketTypes ?? []).map((t, i) => (
                      <View key={t.id}>
                        {i > 0 ? <Separator /> : null}
                        <TicketTypeRow
                          ticketType={t}
                          timeZone={tz}
                          quantity={quantities[t.id] ?? 0}
                          onChange={(q) => setQuantities((cur) => ({ ...cur, [t.id]: q }))}
                        />
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </Card>
        </View>
      </ScrollView>

      {session ? (
        <BookingBar>
          <View className="flex-row items-center gap-4">
            <View className="flex-1">
              {totalQty > 0 ? (
                <>
                  <Text variant="meta" tone="muted">
                    {totalQty} {totalQty === 1 ? 'ticket' : 'tickets'}, before fees
                  </Text>
                  <Text variant="figureSm">{formatMoney(subtotalMinor, currency)}</Text>
                </>
              ) : fromMinor != null ? (
                <Text variant="ui" tone="muted">
                  {fromMinor === 0 ? '' : 'From '}
                  <Text variant="figureSm">
                    {fromMinor === 0 ? 'Free' : formatMoney(fromMinor, currency)}
                  </Text>
                </Text>
              ) : (
                <Text variant="ui" tone="muted">
                  Not on sale yet
                </Text>
              )}
            </View>
            {reservedSeating ? (
              <Button label="Choose seats" size="lg" fullWidth={false} onPress={goToSeats} />
            ) : totalQty > 0 ? (
              <Button label="Continue" size="lg" fullWidth={false} onPress={goToCheckout} />
            ) : (
              <Button
                label="Choose tickets"
                size="lg"
                fullWidth={false}
                disabled={fromMinor == null}
                onPress={toTickets}
              />
            )}
          </View>
        </BookingBar>
      ) : null}
    </Screen>
  );
}

function TitleBlock({
  event,
  session,
  fromMinor,
  currency,
}: {
  event: EventDetail;
  session?: EventSession;
  fromMinor: number | null;
  currency: string;
}) {
  const tz = event.timeZone ?? undefined;
  const eyebrow = [
    event.category,
    event.venue.city,
    session ? longDate(session.startsAt, tz) : null,
  ]
    .filter(Boolean)
    .join('  -  ');
  return (
    <View className="items-center gap-3 px-6 pb-7 pt-4">
      <Text variant="eyebrow" tone="gold" className="text-center">
        {eyebrow}
      </Text>
      <ContentLabelPill label={event.contentLabel} centered />
      <Text variant="d1" accessibilityRole="header" className="text-center">
        {event.title}
      </Text>
      <GoldRule className="mt-1" />
      {fromMinor != null ? (
        <Text variant="ui" tone="muted" className="mt-1">
          {fromMinor === 0 ? '' : 'From '}
          <Text variant="figureSm">
            {fromMinor === 0 ? 'Free' : formatMoney(fromMinor, currency)}
          </Text>
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The venue's address as one line. An organizer's address usually already names the city
 * ("Whitefield, Bengaluru, KA"), so the city is added only when it is missing.
 */
function venueLine(event: EventDetail): string {
  const { address, city, country } = event.venue;
  if (!address) return [city, country].filter(Boolean).join(', ');
  const parts = [address];
  if (!address.toLowerCase().includes(city.toLowerCase())) parts.push(city);
  if (country && !address.toLowerCase().includes(country.toLowerCase())) parts.push(country);
  return parts.join(', ');
}

/** "Friday 30 October", in the venue's zone, for the eyebrow. */
function longDate(iso: string, timeZone?: string): string {
  try {
    return new Date(iso)
      .toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone,
      })
      .replace(',', '');
  } catch {
    return formatShortDate(iso);
  }
}

/** The storefront's facts grid: two columns, hairlines between, a heavier rule on top. */
function FactsGrid({ event, session }: { event: EventDetail; session: EventSession }) {
  const tz = event.timeZone ?? undefined;
  const minutes = Math.round(
    (new Date(session.endsAt).getTime() - new Date(session.startsAt).getTime()) / 60_000,
  );
  const duration =
    minutes > 0
      ? minutes < 60
        ? `${minutes} min`
        : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
      : null;
  const cells: { label: string; value: string }[] = [
    { label: 'Date', value: longDate(session.startsAt, tz) },
    { label: 'Time', value: formatShortTime(session.startsAt, tz) },
    { label: 'Venue', value: event.venue.name },
    ...(duration ? [{ label: 'Duration', value: duration }] : []),
    ...(event.ageLimit ? [{ label: 'Audience', value: `Age ${event.ageLimit}+` }] : []),
  ];
  const rows: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));

  return (
    <View className="mx-4 mt-7 border-t-2 border-ink">
      {rows.map((row, r) => (
        <View key={r} className={`flex-row ${r > 0 ? 'border-t border-border' : ''}`}>
          {row.map((c, i) => (
            <View
              key={c.label}
              className={`flex-1 gap-1 py-4 ${i === 1 ? 'border-l border-border pl-4' : 'pr-4'}`}
            >
              <Eyebrow>{c.label}</Eyebrow>
              <Text variant="card">{c.value}</Text>
            </View>
          ))}
          {row.length === 1 ? <View className="flex-1" /> : null}
        </View>
      ))}
      {tz ? (
        <Text variant="meta" tone="muted" className="border-t border-border pt-3">
          Times are at the venue, in its time zone.
        </Text>
      ) : null}
    </View>
  );
}

/** A date tile, as on the storefront's film page: "FRI / 13 Nov / 8:00 pm", ink when selected. */
function DateTile({
  startsAt,
  timeZone,
  selected,
  onPress,
}: {
  startsAt: string;
  timeZone?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const [weekday, day, month] = formatShortDate(startsAt, timeZone).split(' ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${formatEventWhen(startsAt, timeZone)}`}
      onPress={() => {
        haptics.select();
        onPress();
      }}
      style={{ width: 84, minHeight: 84 }}
      className={`items-center justify-center gap-0.5 rounded-control border ${
        selected ? 'border-ink bg-ink' : 'border-border-strong bg-background-surface'
      }`}
    >
      <Text variant="eyebrow" tone={selected ? 'onAccent' : 'secondary'}>
        {weekday ?? ''}
      </Text>
      <Text variant="uiStrong" tone={selected ? 'onAccent' : 'primary'}>
        {[day, month].filter(Boolean).join(' ')}
      </Text>
      <Text variant="meta" tone={selected ? 'onAccent' : 'secondary'}>
        {formatShortTime(startsAt, timeZone)}
      </Text>
    </Pressable>
  );
}

function TicketTypeRow({
  ticketType,
  timeZone,
  quantity,
  onChange,
}: {
  ticketType: TicketType;
  timeZone?: string;
  quantity: number;
  onChange: (q: number) => void;
}) {
  const onSale = isOnSale(ticketType);
  const soldOut = onSale && ticketType.available <= 0;
  // Whichever runs out first: what is left, or what one order may contain.
  const max = Math.min(ticketType.maxPerOrder, ticketType.available);
  const note = !onSale
    ? ticketType.salesStartAt
      ? `Sales start ${formatEventWhen(ticketType.salesStartAt, timeZone)}`
      : 'Sales closed'
    : soldOut
      ? 'Sold out'
      : `${ticketType.available} left`;

  return (
    <View className="flex-row items-center gap-3 py-4">
      <View className="flex-1 gap-1">
        <View className="flex-row items-baseline justify-between gap-3">
          <Text variant="card" className="flex-1">
            {ticketType.name}
          </Text>
          <Text variant="body" className="font-semibold" tabular>
            {ticketType.priceMinor === 0
              ? 'Free'
              : formatMoney(ticketType.priceMinor, ticketType.currency)}
          </Text>
        </View>
        <Text
          variant="eyebrow"
          tone={!onSale || soldOut ? 'muted' : ticketType.available <= 10 ? 'danger' : 'gold'}
        >
          {note}
        </Text>
      </View>
      {onSale && !soldOut ? (
        <QuantityStepper
          value={quantity}
          onChange={onChange}
          max={max}
          label={`${ticketType.name} tickets`}
        />
      ) : null}
    </View>
  );
}

function EventSkeleton() {
  return (
    <Screen padded={false} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <TopBar />
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Loading event"
        className="items-center gap-3 px-6 pt-4"
      >
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-9 w-52" />
        <Skeleton className="mt-4 aspect-video w-full rounded-card" />
      </View>
    </Screen>
  );
}

async function shareEvent(event: EventDetail) {
  const url = `https://${env.webHost ?? 'eticketsgo.com'}/events/${event.slug}`;
  try {
    await Share.share({ message: `${event.title} - ${url}`, url, title: event.title });
  } catch {
    // The customer closed the share sheet, or the platform has none: nothing to do.
  }
}

async function openDirections(event: EventDetail) {
  const query = encodeURIComponent(
    [event.venue.name, event.venue.address, event.venue.city].filter(Boolean).join(', '),
  );
  await Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${query}`).catch(
    () => undefined,
  );
}
