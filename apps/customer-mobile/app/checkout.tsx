import { useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '@/components/screen';
import { ErrorState, OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useAuth } from '@/hooks/use-auth';
import { Button, Card, Field, IconButton, Separator, Text } from '@/ui';
import { formatMoney } from '@/services/locale';
import { messageForError } from '@/services/errors';
import { useEvent } from '@/features/events/api';
import {
  followPaymentAction,
  newIdempotencyKey,
  paymentReturnUrl,
  useCreateBooking,
  useStartPayment,
  type CartItem,
} from '@/features/checkout/api';
import { HoldCountdown } from '@/features/checkout/hold-countdown';

/**
 * Checkout: confirm what's being bought, create the hold, then pay.
 *
 * The order of operations is deliberate and matches the API's. The booking is created
 * FIRST, which is what reserves inventory and produces the authoritative fee breakdown;
 * only then is a payment started. The screen never computes a total — it renders the
 * one the API returned, because platform fees, the payment fee and the organizer's
 * feeMode all land server-side and a client estimate that disagrees with the charge is
 * the single worst bug this screen could have.
 */
export default function CheckoutScreen() {
  const params = useLocalSearchParams<{
    eventId?: string;
    sessionId?: string;
    slug?: string;
    items?: string;
    /** Human-readable seat labels ("A1, A2") for reserved-seating checkouts. */
    seatNames?: string;
  }>();
  const router = useRouter();
  const online = useOnline();
  const { user, isAuthenticated } = useAuth();

  const items = useMemo<CartItem[]>(() => {
    try {
      const parsed = JSON.parse(params.items ?? '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [params.items]);

  const { data: event } = useEvent(params.slug ?? '');
  const session = event?.sessions.find((s) => s.id === params.sessionId);

  /**
   * The buyer fields are DERIVED from the session with a local override, rather than
   * initialised from it and then patched by an effect.
   *
   * The session hydrates asynchronously, so on the first render `user` is usually still
   * null — an initial useState(user?.email) would capture the empty value and never
   * update. Copying it across in an effect once it arrives is the usual patch, and it
   * is the thing that overwrites an email a fast typist has already entered. Deriving
   * sidesteps both: null means "not edited, show whatever the session knows now", and
   * the first keystroke pins it.
   */
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [emailOverride, setEmailOverride] = useState<string | null>(null);
  const buyerName = nameOverride ?? user?.fullName ?? '';
  const buyerEmail = emailOverride ?? user?.email ?? '';
  const setBuyerName = setNameOverride;
  const setBuyerEmail = setEmailOverride;
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});

  const createBooking = useCreateBooking();
  const startPayment = useStartPayment();
  const booking = createBooking.data;

  /**
   * One key per checkout attempt, held in a ref so a re-render cannot mint a new one.
   * See the comment on useCreateBooking for why reusing it is the point.
   */
  const idempotencyKey = useRef(newIdempotencyKey());

  const [paying, setPaying] = useState(false);

  const lineItems = useMemo(
    () =>
      items
        .map((i) => ({ item: i, type: session?.ticketTypes.find((t) => t.id === i.ticketTypeId) }))
        .filter((r) => r.type),
    [items, session],
  );

  if (!params.sessionId || items.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Checkout' }} />
        <ErrorState
          title="Nothing to check out"
          message="Your selection was lost. Choose your tickets again."
          onRetry={() => router.back()}
        />
      </Screen>
    );
  }

  const validate = () => {
    const next: typeof errors = {};
    if (buyerName.trim().length < 2) next.name = 'Enter the name on the booking.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(buyerEmail.trim()))
      next.email = 'Enter a valid email address — your tickets are sent here.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onPay = async () => {
    if (!validate()) return;
    setPaying(true);
    try {
      // Reuse an existing hold if the user already got this far and came back, rather
      // than creating a second one against the same inventory.
      const created =
        booking ??
        (await createBooking.mutateAsync({
          eventSessionId: params.sessionId!,
          items,
          buyerName: buyerName.trim(),
          buyerEmail: buyerEmail.trim(),
          idempotencyKey: idempotencyKey.current,
        }));

      const intent = await startPayment.mutateAsync(created.id);
      const outcome = await followPaymentAction(intent, paymentReturnUrl(created.id));

      if (outcome.kind === 'unsupported') {
        Alert.alert('Payment unavailable', outcome.reason);
        return;
      }
      if (outcome.kind === 'dismissed') {
        // The hold is still alive; the user can try again until it lapses.
        Alert.alert('Payment not completed', 'Your tickets are held for a few more minutes.');
        return;
      }

      // The browser came back, or the internal action returned. Neither proves the
      // booking is paid — the booking screen re-reads the server's status and is the
      // only thing that decides what the user is told.
      router.replace({ pathname: '/booking/[id]', params: { id: created.id } });
    } catch (err) {
      Alert.alert('Something went wrong', messageForError(err));
    } finally {
      setPaying(false);
    }
  };

  const fees = booking?.fees;
  const currency = fees?.currency ?? session?.ticketTypes[0]?.currency ?? 'INR';
  const estimatedSubtotal = lineItems.reduce(
    (n, r) => n + (r.type?.priceMinor ?? 0) * r.item.quantity,
    0,
  );

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
        <Text variant="callout" className="flex-1 font-semibold">
          Checkout
        </Text>
      </View>

      <ScrollView contentContainerClassName="gap-5 px-5 pb-6 pt-2" keyboardDismissMode="on-drag">
        {booking?.holdExpiresAt ? (
          <HoldCountdown
            expiresAt={booking.holdExpiresAt}
            onExpired={() => {
              Alert.alert(
                'Your hold expired',
                'Those tickets have been released. Please start again.',
              );
              router.back();
            }}
          />
        ) : null}

        <View className="gap-2">
          <Text variant="title3" accessibilityRole="header">
            {event?.title ?? 'Your tickets'}
          </Text>
          {params.seatNames ? (
            <Text variant="subhead" tone="muted">
              Seats {params.seatNames}
            </Text>
          ) : null}
          <Card padded={false}>
            {lineItems.map((r, i) => (
              <View key={r.item.ticketTypeId}>
                {i > 0 ? <Separator /> : null}
                <View className="flex-row items-center justify-between p-4">
                  <View className="flex-1">
                    <Text variant="body">
                      {r.type?.name} × {r.item.quantity}
                    </Text>
                    {r.item.seatIds?.length ? (
                      <Text variant="caption" tone="muted">
                        Reserved seating
                      </Text>
                    ) : null}
                  </View>
                  <Text variant="body" className="font-semibold">
                    {formatMoney((r.type?.priceMinor ?? 0) * r.item.quantity, currency)}
                  </Text>
                </View>
              </View>
            ))}
          </Card>
        </View>

        <View className="gap-3">
          <Text variant="title3" accessibilityRole="header">
            Where should we send them?
          </Text>
          <Field
            label="Full name"
            value={buyerName}
            onChangeText={setBuyerName}
            error={errors.name}
            autoComplete="name"
            textContentType="name"
            editable={!paying}
          />
          <Field
            label="Email"
            value={buyerEmail}
            onChangeText={setBuyerEmail}
            error={errors.email}
            hint="Your tickets and receipt go to this address."
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            editable={!paying}
          />
          {!isAuthenticated ? (
            <Text variant="footnote" tone="muted">
              You&rsquo;re checking out as a guest. Create an account afterwards to keep this
              booking with your others.
            </Text>
          ) : null}
        </View>

        <View className="gap-2">
          <Text variant="title3" accessibilityRole="header">
            Total
          </Text>
          <Card className="gap-2">
            {fees ? (
              <>
                <Line label="Tickets" value={formatMoney(fees.subtotalMinor, currency)} />
                {fees.discountMinor > 0 ? (
                  <Line label="Discount" value={`−${formatMoney(fees.discountMinor, currency)}`} />
                ) : null}
                {fees.customerFeeMinor > 0 ? (
                  <Line
                    label="Booking &amp; payment fees"
                    value={formatMoney(fees.customerFeeMinor, currency)}
                  />
                ) : null}
                <Separator />
                <View className="flex-row items-center justify-between">
                  <Text variant="headline">Total</Text>
                  <Text variant="title3">{formatMoney(fees.totalMinor, currency)}</Text>
                </View>
              </>
            ) : (
              <>
                <Line label="Tickets" value={formatMoney(estimatedSubtotal, currency)} />
                {/* Before the booking exists there is no server-calculated fee, and
                    inventing one would mean showing a number that changes at the moment
                    of payment. Saying so is better than guessing. */}
                <Text variant="footnote" tone="muted">
                  Booking and payment fees are calculated when you continue.
                </Text>
              </>
            )}
          </Card>
        </View>
      </ScrollView>

      <View className="border-t border-border bg-background-surface px-5 pb-2 pt-3">
        <Button
          label={fees ? `Pay ${formatMoney(fees.totalMinor, currency)}` : 'Continue to payment'}
          size="lg"
          loading={paying}
          disabled={!online}
          onPress={() => void onPay()}
        />
        {!online ? (
          <Text variant="footnote" tone="muted" className="mt-2 text-center">
            You need a connection to complete a booking.
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between">
      <Text variant="subhead" tone="secondary">
        {label}
      </Text>
      <Text variant="subhead">{value}</Text>
    </View>
  );
}
