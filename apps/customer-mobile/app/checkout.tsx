import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/components/screen';
import { TopBar } from '@/components/top-bar';
import { BookingBar } from '@/components/booking-bar';
import { palette } from '@/theme';
import { ErrorState, OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useAuth } from '@/hooks/use-auth';
import { Button, Card, Eyebrow, Field, Separator, Text } from '@/ui';
import { formatEventWhen, formatMoney } from '@/services/locale';
import { messageForError } from '@/services/errors';
import { useEvent } from '@/features/events/api';
import {
  followPaymentAction,
  newIdempotencyKey,
  paymentReturnUrl,
  useCreateBooking,
  useQuote,
  useStartPayment,
  type CartItem,
} from '@/features/checkout/api';
import { HoldCountdown } from '@/features/checkout/hold-countdown';
import { feeLines } from '@/features/checkout/fee-lines';
import { readBookingStatus } from '@/features/checkout/booking-status';
import { bookingKeys } from '@/features/bookings/api';

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

  /** What the buyer typed, and the code actually sent for pricing (set on Apply). */
  const [couponInput, setCouponInput] = useState('');
  const [couponCode, setCouponCode] = useState<string | null>(null);

  const createBooking = useCreateBooking();
  const startPayment = useStartPayment();
  const booking = createBooking.data;
  const quote = useQuote(params.sessionId, items, couponCode);
  const couponRejected = Boolean(couponCode) && quote.data?.coupon?.applied === false;

  /**
   * One key per checkout attempt, held in a ref so a re-render cannot mint a new one.
   * See the comment on useCreateBooking for why reusing it is the point.
   */
  const idempotencyKey = useRef(newIdempotencyKey());

  const [paying, setPaying] = useState(false);
  /*
    Set synchronously on the first tap. `paying` is React state, so it only takes effect
    on the next render, and a fast second tap landed before it: two /pay calls, two
    provider orders for one booking. A ref cannot be stale.
  */
  const inFlight = useRef(false);
  const queryClient = useQueryClient();

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
      next.email = 'Enter a valid email address. Your tickets are sent here.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onPay = async () => {
    if (inFlight.current) return;
    if (!validate()) return;
    inFlight.current = true;
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
          // Only a code the quote accepted. A rejected one would be refused again here,
          // after seats are held, for no gain.
          ...(couponCode && !couponRejected ? { couponCode } : {}),
          idempotencyKey: idempotencyKey.current,
        }));

      /*
        A free booking is already done.

        The API skipped the payment provider entirely — a free event has nothing to collect
        and a gateway asked to charge zero is a support ticket, not a payment — and returned
        the booking CONFIRMED with no payment attached. Calling /pay on it would be refused,
        and the buyer would be shown a failure over a ticket they already hold.

        Read from the SERVER's status rather than from anything this screen knows about the
        event, because the server is the only party that knows whether money was skipped.
      */
      if (created.status === 'CONFIRMED') {
        router.replace({ pathname: '/booking/[id]', params: { id: created.id } });
        return;
      }

      const intent = await startPayment.mutateAsync(created.id);
      const outcome = await followPaymentAction(intent, paymentReturnUrl(created.id), created.id);

      if (outcome.kind === 'unsupported') {
        Alert.alert('Payment unavailable', outcome.reason);
        return;
      }

      const goToBooking = () => {
        void queryClient.invalidateQueries({ queryKey: bookingKeys.all });
        router.replace({ pathname: '/booking/[id]', params: { id: created.id } });
      };

      if (outcome.kind === 'completed') {
        // The buyer finished the provider's steps. That proves nothing about money; the
        // booking screen waits for the server to confirm it.
        goToBooking();
        return;
      }

      /*
        Closed or refused on the device. Ask the server before saying so: a hosted page
        that returns to the website (Stripe) leaves the buyer to close the browser
        themselves, so "dismissed" is also what a successful payment looks like here.
      */
      const status = await readBookingStatus(created.id);
      if (status && status !== 'PENDING_PAYMENT') {
        goToBooking();
        return;
      }
      Alert.alert(
        'Payment not completed',
        outcome.kind === 'failed' && outcome.reason
          ? `${outcome.reason}

Your tickets are still held for a few minutes. You can try again.`
          : 'Your tickets are still held for a few minutes. You can try again.',
      );
    } catch (err) {
      Alert.alert('Something went wrong', messageForError(err));
    } finally {
      inFlight.current = false;
      setPaying(false);
    }
  };

  // The booking's own figures once it exists; the quote's before. Never computed here.
  const fees = booking?.fees ?? quote.data?.fees;
  const currency = fees?.currency ?? session?.ticketTypes[0]?.currency ?? 'INR';
  const estimatedSubtotal = lineItems.reduce(
    (n, r) => n + (r.type?.priceMinor ?? 0) * r.item.quantity,
    0,
  );

  const when = session ? formatEventWhen(session.startsAt, event?.timeZone ?? undefined) : null;
  const totalLabel = fees ? formatMoney(fees.totalMinor, currency) : null;

  return (
    <Screen padded={false} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <TopBar title="Checkout" />
      {!online ? <OfflineBanner /> : null}

      <ScrollView
        contentContainerClassName="gap-7 px-4 pb-8 pt-2"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
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

        <Card className="gap-4 p-5">
          <View className="gap-1">
            <Eyebrow>Your order</Eyebrow>
            <Text variant="d3" accessibilityRole="header">
              {event?.title ?? 'Your tickets'}
            </Text>
            {when ? (
              <Text variant="meta" tone="secondary">
                {when}
                {event?.venue.name ? ` - ${event.venue.name}, ${event.venue.city}` : ''}
              </Text>
            ) : null}
            {params.seatNames ? (
              <Text variant="uiStrong" className="mt-1">
                Seats {params.seatNames}
              </Text>
            ) : null}
          </View>
          <Separator />
          {lineItems.map((r) => (
            <View key={r.item.ticketTypeId} className="flex-row items-center justify-between gap-3">
              <Text variant="body" className="flex-1">
                {r.type?.name}
                <Text variant="body" tone="muted">
                  {'  x '}
                  {r.item.quantity}
                </Text>
              </Text>
              <Text variant="body" className="font-semibold" tabular>
                {formatMoney((r.type?.priceMinor ?? 0) * r.item.quantity, currency)}
              </Text>
            </View>
          ))}
        </Card>

        <View className="gap-4">
          <Eyebrow>Send tickets to</Eyebrow>
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
            // The API books only for a signed-in account (POST /bookings is 401 without
            // one). Its guest route needs a browser human check this app cannot run, so
            // offering guest checkout here led to a refusal after the buyer filled the form.
            <Card tone="sunken" className="gap-1">
              <Text variant="uiStrong">Sign in to book</Text>
              <Text variant="ui" tone="secondary">
                Your tickets are kept in your account, so you can open them on any device.
              </Text>
            </Card>
          ) : null}
        </View>

        <View className="gap-3">
          <Field
            label="Discount code"
            placeholder="Optional"
            value={couponInput}
            onChangeText={setCouponInput}
            autoCapitalize="characters"
            autoCorrect={false}
            // The code is fixed into the booking when seats are held.
            editable={!booking && !paying}
            error={couponRejected ? 'This code does not apply to these tickets.' : undefined}
            hint={
              booking
                ? 'Codes can be changed only before your tickets are held.'
                : quote.data?.coupon?.applied
                  ? `Code ${quote.data.coupon.code} applied.`
                  : undefined
            }
          />
          <Button
            label="Apply code"
            variant="secondary"
            fullWidth={false}
            disabled={Boolean(booking) || paying || couponInput.trim().length === 0}
            loading={quote.isFetching && Boolean(couponCode)}
            onPress={() => setCouponCode(couponInput.trim().toUpperCase())}
          />
        </View>

        <Card className="gap-3 p-5">
          <Eyebrow>Price breakdown</Eyebrow>
          {fees ? (
            <>
              <Line label="Tickets" value={formatMoney(fees.subtotalMinor, currency)} />
              {feeLines(fees).map((line) => (
                <Line
                  key={line.label}
                  label={line.label}
                  value={
                    line.minor < 0
                      ? `-${formatMoney(-line.minor, currency)}`
                      : formatMoney(line.minor, currency)
                  }
                />
              ))}
              <View className="h-[2px] bg-ink" />
              <View className="flex-row items-center justify-between">
                <Text variant="uiStrong">Total</Text>
                <Text variant="figureSm">{formatMoney(fees.totalMinor, currency)}</Text>
              </View>
              <Text variant="meta" tone="muted">
                This is the total you will be charged. Every fee is listed above.
              </Text>
            </>
          ) : (
            <>
              <Line label="Tickets" value={formatMoney(estimatedSubtotal, currency)} />
              {/* The quote has not answered yet. Inventing a fee meanwhile would show a
                  number that changes at the moment of payment. */}
              <Text variant="meta" tone="muted">
                {quote.isError
                  ? 'We could not get the final price. It is shown before you pay.'
                  : 'Getting the final price...'}
              </Text>
            </>
          )}
        </Card>

        <View className="flex-row items-center gap-2 px-1">
          <Ionicons name="lock-closed-outline" size={15} color={palette.textMuted} />
          <Text variant="meta" tone="muted" className="flex-1">
            Payment is handled by our payment partner. We never see your card number.
          </Text>
        </View>
      </ScrollView>

      <BookingBar>
        {isAuthenticated ? (
          <View className="flex-row items-center gap-4">
            <View className="flex-1">
              <Text variant="meta" tone="muted">
                Total
              </Text>
              <Text variant="figureSm">{totalLabel ?? '...'}</Text>
            </View>
            <Button
              label={fees ? 'Pay now' : 'Continue to payment'}
              accessibilityLabel={totalLabel ? `Pay ${totalLabel}` : 'Continue to payment'}
              size="lg"
              fullWidth={false}
              loading={paying}
              disabled={!online}
              onPress={() => void onPay()}
            />
          </View>
        ) : (
          <Button
            label="Sign in to continue"
            size="lg"
            disabled={!online}
            onPress={() => router.push('/(auth)/login')}
          />
        )}
        {!online ? (
          <Text variant="meta" tone="muted" className="mt-2 text-center">
            You need a connection to complete a booking.
          </Text>
        ) : null}
      </BookingBar>
    </Screen>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text variant="ui" tone="secondary">
        {label}
      </Text>
      <Text variant="ui" className="font-medium" tabular>
        {value}
      </Text>
    </View>
  );
}
