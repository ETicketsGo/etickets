import { useState } from 'react';
import { ScrollView, Switch, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/screen';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { ListGroup, ListRow, SectionHeader, Separator, Text } from '@/ui';
import {
  fetchConsent,
  fetchNotificationPreferences,
  setConsent as saveConsentApi,
  setNotificationPreference,
} from '@/features/account/notification-settings';

/**
 * Notification settings, matching the web account page.
 *
 * ── WHY THE SAME SEMANTICS AND NOT THE SAME COMPONENTS ─────────────────────────────
 * The rules a customer is subject to must be identical on both surfaces — the same required
 * channels, the same separation of booking updates from offers — because they are properties
 * of the platform, not of the screen. The API returns `required` and `deferred` per channel,
 * so both clients read the same answer rather than each deciding for itself which toggles to
 * grey out. That is where the consistency has to live; a shared component could not span
 * React DOM and React Native anyway.
 *
 * ── WHY THE PLATFORM SWITCH ────────────────────────────────────────────────────────
 * React Native's `Switch` is the real thing: it announces correctly, honours the OS reduce-
 * motion and larger-text settings, and looks like every other switch on the device. Building
 * a custom one to match the web pixel-for-pixel would make it worse in every way somebody
 * using a screen reader would notice.
 */

const TYPE_LABELS: Record<string, string> = {
  BOOKING_CONFIRMED: 'Booking confirmations',
  SHOW_CANCELLED: 'Cancelled shows',
  SHOW_CHANGED: 'Schedule changes',
  BOOKING_CANCELLED: 'Booking cancellations',
  REFUND_COMPLETED: 'Refunds',
  EVENT_REMINDER: 'Reminders',
};

const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  push: 'Push',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
};

export default function NotificationSettingsScreen() {
  const online = useOnline();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const prefs = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: fetchNotificationPreferences,
  });
  const consent = useQuery({
    queryKey: ['marketing-consent'],
    queryFn: fetchConsent,
  });

  const savePreference = useMutation({
    mutationFn: (body: { type: string; channel: string; enabled: boolean }) =>
      setNotificationPreference(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-preferences'] }),
    onError: () => setError('Could not save that. Please try again.'),
  });
  const saveConsent = useMutation({
    mutationFn: (body: { channel: string; granted: boolean }) => saveConsentApi(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['marketing-consent'] }),
    onError: () => setError('Could not save that. Please try again.'),
  });

  const consentFor = (channel: string) =>
    consent.data?.channels.find((c) => c.channel === channel)?.granted ?? false;
  const hasPhone = prefs.data?.destinations.hasPhone ?? false;

  if (prefs.isLoading) return <LoadingState />;
  if (prefs.isError) {
    return <ErrorState message="We couldn't load your settings." onRetry={() => prefs.refetch()} />;
  }

  return (
    <Screen padded={false}>
      {!online ? <OfflineBanner /> : null}
      <ScrollView contentContainerClassName="pb-10" showsVerticalScrollIndicator={false}>
        <View className="px-5 pb-4 pt-2">
          <Text variant="largeTitle" accessibilityRole="header">
            Notifications
          </Text>
          <Text variant="subhead" tone="muted" className="mt-1">
            Critical booking and show updates are always sent on at least one required channel, so
            you never miss a cancellation.
          </Text>
        </View>

        {error ? (
          <View className="mx-5 mb-4">
            <Text variant="footnote" tone="danger">
              {error}
            </Text>
          </View>
        ) : null}

        <SectionHeader title="Booking updates on WhatsApp" />
        <ListGroup>
          <ListRow
            label="Booking updates on WhatsApp"
            /* Deliberately spells out what it is NOT: the marketing switch below is a
               different decision, and bundling them is how somebody who declined offers
               stops receiving their tickets. */
            accessibilityHint="Confirmations, ticket updates, show changes and refunds. Never offers."
            showChevron={false}
            right={
              <Switch
                value={consentFor('whatsapp:transactional')}
                disabled={!hasPhone || saveConsent.isPending}
                accessibilityLabel="Receive booking updates on WhatsApp"
                onValueChange={(granted) =>
                  saveConsent.mutate({ channel: 'whatsapp:transactional', granted })
                }
              />
            }
          />
          {!hasPhone ? (
            <>
              <Separator inset />
              <ListRow
                label="Add a phone number"
                icon="call-outline"
                accessibilityHint="Needed before WhatsApp updates can be sent"
                // The existing profile flow owns phone numbers. A second collection point
                // here would be a second thing to keep in step with verification.
                onPress={() => router.push('/(tabs)/profile')}
              />
            </>
          ) : null}
        </ListGroup>

        <SectionHeader title="What we send you" />
        {prefs.data?.types.map((entry) => {
          const label = TYPE_LABELS[entry.type];
          if (!label) return null;
          return (
            <View key={entry.type} className="mb-4">
              <ListGroup>
                {entry.channels.map((c, i) => (
                  <View key={c.channel}>
                    {i > 0 ? <Separator inset /> : null}
                    <ListRow
                      label={`${label} — ${CHANNEL_LABELS[c.channel] ?? c.channel}`}
                      showChevron={false}
                      /*
                        The emergency SMS is not a preference: it opens only if a cancelled
                        show reached you nowhere else. Shown as a statement rather than a
                        switch, because offering to disable the message that exists to catch
                        every other message failing is not a choice worth offering.
                      */
                      value={c.deferred ? 'Emergency only' : c.required ? 'Required' : undefined}
                      right={
                        c.deferred || c.required ? undefined : (
                          <Switch
                            value={c.enabled}
                            disabled={savePreference.isPending}
                            accessibilityLabel={`${CHANNEL_LABELS[c.channel] ?? c.channel} for ${label}`}
                            onValueChange={(enabled) =>
                              savePreference.mutate({
                                type: entry.type,
                                channel: c.channel,
                                enabled,
                              })
                            }
                          />
                        )
                      }
                    />
                  </View>
                ))}
              </ListGroup>
            </View>
          );
        })}

        <SectionHeader title="Offers and recommendations" />
        <ListGroup>
          {(['email', 'push', 'whatsapp'] as const).map((channel, i) => (
            <View key={channel}>
              {i > 0 ? <Separator inset /> : null}
              <ListRow
                label={CHANNEL_LABELS[channel]}
                showChevron={false}
                right={
                  <Switch
                    value={consentFor(channel)}
                    disabled={consent.isLoading || saveConsent.isPending}
                    accessibilityLabel={`Marketing on ${CHANNEL_LABELS[channel]}`}
                    onValueChange={(granted) => saveConsent.mutate({ channel, granted })}
                  />
                }
              />
            </View>
          ))}
        </ListGroup>
        <View className="px-5 pt-3">
          <Text variant="footnote" tone="muted">
            Turning these off never affects your tickets, booking updates, or anything about a show
            you have paid for.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
