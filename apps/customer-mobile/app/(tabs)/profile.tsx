import { Alert, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { Screen } from '@/components/screen';
import { OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useAuth } from '@/hooks/use-auth';
import { Button, ListGroup, ListRow, Separator, Text } from '@/ui';
import { deviceLocale } from '@/services/locale';
import { legalLinks } from '@/services/legal';
import { env } from '@/services/env';

/**
 * Account and settings.
 *
 * Readable signed out — the legal and support rows are exactly what someone deciding
 * whether to create an account wants to read first, so gating them behind sign-in would
 * be backwards. Only the identity block and Sign out depend on a session.
 */
export default function ProfileScreen() {
  const online = useOnline();
  const router = useRouter();
  const { user, isAuthenticated, logout } = useAuth();

  const confirmSignOut = () => {
    Alert.alert('Sign out?', 'You can sign back in at any time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void logout() },
    ]);
  };

  return (
    <Screen padded={false}>
      {!online ? <OfflineBanner /> : null}
      <ScrollView contentContainerClassName="pb-10" showsVerticalScrollIndicator={false}>
        <View className="px-5 pb-4 pt-2">
          <Text variant="largeTitle" accessibilityRole="header">
            Profile
          </Text>
        </View>

        {isAuthenticated && user ? (
          <View className="mx-5 mb-6 gap-1 rounded-md border border-border bg-background-surface p-4">
            <Text variant="title3">{user.fullName}</Text>
            <Text variant="subhead" tone="muted">
              {user.email}
            </Text>
          </View>
        ) : (
          <View className="mx-5 mb-6 gap-3 rounded-md border border-border bg-background-surface p-4">
            <Text variant="headline">You&rsquo;re browsing as a guest</Text>
            <Text variant="subhead" tone="muted">
              Sign in to keep your tickets in one place across devices.
            </Text>
            <Button label="Sign in" onPress={() => router.push('/(auth)/login')} />
          </View>
        )}

        <View className="gap-6">
          <Section title="Preferences">
            <ListRow label="Region" value={deviceLocale.region} showChevron={false} />
            <Separator inset />
            <ListRow label="Language" value={deviceLocale.tag} showChevron={false} />
            <Separator inset />
            <ListRow label="Time zone" value={deviceLocale.timeZone} showChevron={false} />
          </Section>

          <Section title="Legal">
            {legalLinks().map((link, index) => (
              <View key={link.key}>
                {index > 0 ? <Separator inset /> : null}
                <ListRow
                  label={link.label}
                  icon="document-text-outline"
                  accessibilityHint="Opens in your browser"
                  onPress={() => {
                    // System browser, not a WebView: a legal document should show the
                    // real address bar so the reader can see whose terms these are.
                    void WebBrowser.openBrowserAsync(link.url);
                  }}
                />
              </View>
            ))}
          </Section>

          <Section title="Support">
            <ListRow
              label="Help & contact"
              icon="help-circle-outline"
              onPress={() => router.push('/support')}
              accessibilityHint="Opens the support form"
            />
          </Section>

          {isAuthenticated ? (
            <Section title="Account">
              <ListRow
                label="Delete account"
                icon="trash-outline"
                destructive
                accessibilityHint="Permanently deletes your account"
                onPress={() => router.push('/account/delete')}
              />
              <Separator inset />
              <ListRow
                label="Sign out"
                icon="log-out-outline"
                destructive
                showChevron={false}
                onPress={confirmSignOut}
              />
            </Section>
          ) : null}

          <View className="items-center gap-1 px-5 pt-2">
            <Text variant="caption" tone="muted">
              ETicketsGo {Constants.expoConfig?.version ?? '—'}
            </Text>
            {/* The environment is worth surfacing on non-production builds: it is the
                first question in every "it works on mine" support thread. */}
            {env.env !== 'production' ? (
              <Text variant="caption" tone="muted">
                {env.env.toUpperCase()} build
              </Text>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text variant="footnote" tone="muted" className="px-5 uppercase" accessibilityRole="header">
        {title}
      </Text>
      <ListGroup className="mx-5">{children}</ListGroup>
    </View>
  );
}
