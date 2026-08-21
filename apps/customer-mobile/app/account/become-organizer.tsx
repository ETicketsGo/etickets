import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Screen } from '@/components/screen';
import { OfflineBanner } from '@/components/states';
import { Button, Card, Field, Text } from '@/ui';
import { useAuth } from '@/hooks/use-auth';
import { useOnline } from '@/hooks/use-online';
import {
  alreadyAnOrganizer,
  becomeOrganizer,
  isValidOrganizationName,
  organizerConsoleUrl,
} from '@/features/account/become-organizer';

/**
 * Sell your own tickets, using the account you already have.
 *
 * The customer site gained this and the app did not, so a person could become an organizer
 * on a laptop and nowhere else. It is one form and a handover, so the gap was not worth
 * keeping.
 *
 * The app creates the organization — it is where the session lives, and creating one is
 * what grants the organizer role. Running a cinema afterwards is desk work, so the console
 * itself stays on the web rather than being reimplemented at phone size.
 */
export default function BecomeOrganizerScreen() {
  const router = useRouter();
  const online = useOnline();
  const { user, isAuthenticated } = useAuth();

  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [existing, setExisting] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/(auth)/login');
      return;
    }
    // Somebody who already has an organization does not need the form, and showing it
    // would invite them to create a second one by accident.
    void alreadyAnOrganizer()
      .then(setExisting)
      .catch(() => setExisting(false));
  }, [isAuthenticated, router]);

  const openConsole = () => {
    void WebBrowser.openBrowserAsync(organizerConsoleUrl(user?.email));
  };

  const onSubmit = async () => {
    if (!isValidOrganizationName(name) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await becomeOrganizer({ name, contactEmail: user?.email });
      setDone(true);
    } catch {
      setError('We could not set up your organization. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const settled = done || existing === true;

  return (
    <Screen padded={false}>
      <Stack.Screen options={{ title: 'Become an organizer' }} />
      {!online ? <OfflineBanner /> : null}
      <ScrollView contentContainerClassName="gap-6 p-5 pb-10" showsVerticalScrollIndicator={false}>
        {settled ? (
          <Card className="gap-3">
            <Text variant="title3">
              {done ? 'Your organization is ready' : 'You are already an organizer'}
            </Text>
            <Text variant="subhead" tone="muted">
              The organizer console is a separate sign-in on the web, so you will be asked for your
              password once more. Same account — this one.
            </Text>
            <Button label="Open the organizer console" onPress={openConsole} />
            {done ? (
              <Text variant="footnote" tone="muted">
                ETicketsGo reviews new organizations before they can sell. You can set up your
                venue, screens and shows while that happens.
              </Text>
            ) : null}
          </Card>
        ) : (
          <>
            <View className="gap-2">
              <Text variant="title3">Sell your own tickets</Text>
              <Text variant="subhead" tone="muted">
                Use this same account. Tell us the name of the business that sells the tickets —
                customers see it on their receipts.
              </Text>
            </View>

            <Card className="gap-4">
              <Field
                label="Organization name"
                value={name}
                onChangeText={setName}
                autoFocus
                autoCapitalize="words"
                editable={!submitting}
                placeholder="Asha Cinemas"
                accessibilityHint="The business name customers will see"
              />
              {error ? (
                <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">
                  {error}
                </Text>
              ) : null}
              <Button
                label="Create my organization"
                onPress={() => void onSubmit()}
                loading={submitting}
                disabled={!isValidOrganizationName(name) || submitting || !online}
              />
            </Card>

            <Text variant="footnote" tone="muted">
              Setting up screens, seat layouts and showtimes is done on the web console — there is a
              lot of detail in a seating plan. This step is all that happens here.
            </Text>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
