import { useState } from 'react';
import { Alert, View } from 'react-native';
import { Badge, Button, Card, Eyebrow, Field, Sheet, Text } from '@/ui';
import { useNow } from '@/hooks/use-now';
import { formatEventWhen, formatMoney } from '@/services/locale';
import { messageForError } from '@/services/errors';
import type { BookingDetail } from './schema';
import {
  refundStatusLabel,
  refundWindow,
  useBookingRefunds,
  useCancelUnpaid,
  useRequestRefund,
} from './refunds';

/**
 * "Cancel or refund" on the booking page: release an unpaid hold, ask for a refund while the
 * event's window is open, and follow any refund already asked for. Every decision is the
 * server's; this card offers only what the event declares and shows what the server says.
 */
export function BookingManage({ booking }: { booking: BookingDetail }) {
  const now = useNow(60_000);
  const status = booking.status.toUpperCase();
  const tz = booking.timeZone ?? undefined;
  const refunds = useBookingRefunds(booking.id, status !== 'PENDING_PAYMENT');
  const cancel = useCancelUnpaid(booking.id);
  const request = useRequestRefund(booking.id);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refundWin = refundWindow(
    {
      status,
      startsAt: booking.eventSession.startsAt,
      refundsEnabled: booking.event.refundsEnabled,
      refundCutoffHours: booking.event.refundCutoffHours,
    },
    now,
  );
  const open = (refunds.data ?? []).filter((r) =>
    ['REQUESTED', 'APPROVED', 'PROCESSING'].includes(r.status.toUpperCase()),
  );

  if (status === 'PENDING_PAYMENT') {
    return (
      <Card className="gap-3 p-5">
        <Eyebrow>Not going ahead?</Eyebrow>
        <Text variant="ui" tone="secondary">
          Release these tickets so someone else can have them. You have not been charged.
        </Text>
        <Button
          label="Release my tickets"
          variant="secondary"
          loading={cancel.isPending}
          onPress={() =>
            Alert.alert(
              'Release these tickets?',
              'Your hold ends now and the tickets go back on sale.',
              [
                { text: 'Keep them', style: 'cancel' },
                {
                  text: 'Release',
                  style: 'destructive',
                  onPress: () =>
                    cancel.mutate(undefined, {
                      onError: (err) => Alert.alert('Could not release', messageForError(err)),
                    }),
                },
              ],
            )
          }
        />
      </Card>
    );
  }

  if (refundWin.kind === 'not-applicable' && (refunds.data ?? []).length === 0) return null;

  return (
    <Card className="gap-4 p-5">
      <Eyebrow>Cancel or refund</Eyebrow>

      {(refunds.data ?? []).map((r) => {
        const s = refundStatusLabel(r.status);
        return (
          <View key={r.id} className="gap-1.5 rounded-control bg-sunken p-3">
            <View className="flex-row items-center justify-between gap-2">
              <Text variant="uiStrong">
                {r.amountMinor != null
                  ? formatMoney(r.amountMinor, r.currency ?? booking.currency)
                  : 'Refund'}
              </Text>
              <Badge label={s.label} tone={s.tone} />
            </View>
            <Text variant="meta" tone="muted">
              Asked {formatEventWhen(r.createdAt, tz)}
            </Text>
          </View>
        );
      })}

      {refundWin.kind === 'open' && open.length === 0 ? (
        <>
          <Text variant="ui" tone="secondary">
            You can ask for a refund until {formatEventWhen(refundWin.closesAt, tz)}. The organizer
            approves it, and the money goes back the way you paid.
          </Text>
          <Button label="Ask for a refund" variant="secondary" onPress={() => setAsking(true)} />
        </>
      ) : null}
      {refundWin.kind === 'closed' ? (
        <Text variant="ui" tone="secondary">
          Refunds for this event closed on {formatEventWhen(refundWin.closedAt, tz)}.
        </Text>
      ) : null}
      {refundWin.kind === 'not-offered' ? (
        <Text variant="ui" tone="secondary">
          This event does not offer refunds. If the event is cancelled, you are refunded
          automatically.
        </Text>
      ) : null}
      {booking.event.refundPolicy ? (
        <Text variant="meta" tone="muted">
          {booking.event.refundPolicy}
        </Text>
      ) : null}

      <Sheet visible={asking} onClose={() => setAsking(false)} title="Ask for a refund">
        <View className="gap-4">
          <Field
            label="Why do you want a refund?"
            value={reason}
            onChangeText={(t) => {
              setReason(t);
              setError(null);
            }}
            multiline
            minHeight={100}
            error={error ?? undefined}
            hint="The organizer reads this. A few words is enough."
          />
          <Button
            label="Send request"
            size="lg"
            loading={request.isPending}
            onPress={() => {
              if (reason.trim().length < 3) {
                setError('Tell the organizer why in a few words.');
                return;
              }
              request.mutate(reason, {
                onSuccess: () => {
                  setAsking(false);
                  setReason('');
                },
                onError: (err) => setError(messageForError(err)),
              });
            }}
          />
        </View>
      </Sheet>
    </Card>
  );
}
