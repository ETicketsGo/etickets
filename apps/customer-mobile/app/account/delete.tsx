import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/components/screen';
import { Button, Card, Field, IconButton, Text } from '@/ui';
import { useAuth } from '@/hooks/use-auth';
import { useOnline } from '@/hooks/use-online';
import { useTheme } from '@/theme';
import {
  DELETE_CONFIRMATION_PHRASE,
  deleteAccount,
  isDeletionConfirmed,
} from '@/features/account/delete-account';

/**
 * Account deletion.
 *
 * Required by both app stores for any app that lets you create an account. The screen
 * exists to make the consequences legible BEFORE the irreversible bit, not to talk
 * anyone out of it — the button is plainly available and the copy states facts.
 */
export default function DeleteAccountScreen() {
  const router = useRouter();
  const online = useOnline();
  const { user, expire } = useAuth();

  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = isDeletionConfirmed(confirmation);

  const onDelete = async () => {
    if (!confirmed || submitting) return;
    setSubmitting(true);
    setError(null);

    const outcome = await deleteAccount();

    if (outcome.kind === 'deleted') {
      // The local scrub already happened inside deleteAccount. This drops the in-memory
      // session so the UI cannot render a stale signed-in state on the way out.
      expire();
      Alert.alert(
        'Account deleted',
        'Your account has been deleted. Tickets you already bought remain valid — keep any confirmation email for entry.',
        [{ text: 'OK', onPress: () => router.replace('/(tabs)') }],
      );
      return;
    }

    setSubmitting(false);
    setError(outcome.message);
  };

  return (
    <Screen padded={false} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center gap-1 px-2 py-1">
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
        />
        <Text variant="callout" className="flex-1 font-semibold">
          Delete account
        </Text>
      </View>

      <ScrollView
        contentContainerClassName="gap-5 px-5 pb-8 pt-2"
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-start gap-2 rounded-md bg-status-error/12 px-3 py-3">
          <Ionicons name="warning-outline" size={18} color="#DC2626" />
          <Text variant="subhead" tone="danger" className="flex-1">
            This is permanent. Your account cannot be restored once it is deleted.
          </Text>
        </View>

        <View className="gap-2">
          <Text variant="title3" accessibilityRole="header">
            What happens
          </Text>
          <Card className="gap-3">
            <Consequence
              icon="close-circle-outline"
              title="You are signed out everywhere, immediately"
              detail="Every device loses access the moment the account is deleted."
            />
            <Consequence
              icon="ticket-outline"
              title="Tickets you already bought stay valid"
              detail="Deleting your account does not cancel or refund them. They will no longer be listed in this app, so keep your confirmation email — it is what gets you in."
            />
            <Consequence
              icon="phone-portrait-outline"
              title="Saved tickets are removed from this phone"
              detail="Anything cached for offline use is deleted along with your session."
            />
            <Consequence
              icon="notifications-off-outline"
              title="Notifications stop"
              detail="This device is deregistered and you will receive nothing further."
            />
            <Consequence
              icon="receipt-outline"
              title="Purchase records are kept, without your name on them"
              detail="We are required to retain the financial record of a sale for tax and dispute purposes. Your name and email are removed from those records."
            />
          </Card>
        </View>

        {user?.email ? (
          <Text variant="footnote" tone="muted">
            Deleting the account for {user.email}
          </Text>
        ) : null}

        <View className="gap-2">
          <Field
            label={`Type ${DELETE_CONFIRMATION_PHRASE} to confirm`}
            value={confirmation}
            onChangeText={setConfirmation}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!submitting}
            error={error ?? undefined}
            hint="This step exists so the action cannot happen by mis-tap."
          />
        </View>

        <Button
          label="Delete my account"
          variant="danger"
          size="lg"
          disabled={!confirmed || !online}
          loading={submitting}
          onPress={() => void onDelete()}
        />
        {!online ? (
          <Text variant="footnote" tone="muted" className="text-center">
            You need a connection to delete your account.
          </Text>
        ) : null}

        <Button label="Keep my account" variant="ghost" onPress={() => router.back()} />
      </ScrollView>
    </Screen>
  );
}

function Consequence({
  icon,
  title,
  detail,
}: {
  icon: keyof typeof import('@expo/vector-icons').Ionicons.glyphMap;
  title: string;
  detail: string;
}) {
  const { colors } = useTheme();
  return (
    <View className="flex-row items-start gap-2.5">
      <Ionicons name={icon} size={18} color={colors.textMuted} />
      <View className="flex-1 gap-0.5">
        <Text variant="subhead" className="font-semibold">
          {title}
        </Text>
        <Text variant="footnote" tone="muted">
          {detail}
        </Text>
      </View>
    </View>
  );
}
