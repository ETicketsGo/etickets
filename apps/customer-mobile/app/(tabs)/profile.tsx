import { Alert, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { Screen } from '@/components/screen';
import { BrandMark } from '@/components/brand-mark';
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
    <Screen padded={false} edges={['top']}>
      {!online ? <OfflineBanner /> : null}
      <ScrollView contentContainerClassName="pb-12" showsVerticalScrollIndicator={false}>
        <View className="px-4 pb-5 pt-4">
          <Text variant="d1" accessibilityRole="header">
            Your account
          </Text>
        </View>

        {isAuthenticated && user ? (
          <View className="mx-4 mb-8 flex-row items-center gap-4 rounded-card border border-border bg-background-surface p-5">
            {/* The storefront's avatar: initials on ink. */}
            <View className="h-14 w-14 items-center justify-center rounded-full bg-ink">
              <Text variant="uiStrong" tone="onAccent">
                {initials(user.fullName)}
              </Text>
            </View>
            <View className="flex-1 gap-0.5">
              <Text variant="card" numberOfLines={1}>
                {user.fullName}
              </Text>
              <Text variant="ui" tone="muted" numberOfLines={1}>
                {user.email}
              </Text>
            </View>
          </View>
        ) : (
          <View className="mx-4 mb-8 gap-3 rounded-card bg-sunken p-5">
            <Text variant="d3">You are browsing as a guest</Text>
            <Text variant="ui" tone="secondary">
              Sign in to keep your tickets in one place, on any device.
            </Text>
            <Button label="Sign in" onPress={() => router.push('/(auth)/login')} />
            <Button
              label="Create an account"
              variant="secondary"
              onPress={() => router.push('/(auth)/register')}
            />
          </View>
        )}

        <View className="gap-7">
          <Section title="Preferences">
            <ListRow label="Region" value={deviceLocale.region} showChevron={false} />
            <Separator inset />
            <ListRow label="Language" value={deviceLocale.tag} showChevron={false} />
            <Separator inset />
            <ListRow label="Time zone" value={deviceLocale.timeZone} showChevron={false} />
          </Section>

          {isAuthenticated ? (
            <Section title="Notifications">
              {/*
                Where somebody decides what reaches them, and the only place the platform can
                ask whether it may use WhatsApp for their booking updates. Signed-in only:
                there is no preference to hold for somebody with no account.
              */}
              <ListRow
                label="Notification settings"
                icon="notifications-outline"
                accessibilityHint="Choose how we reach you about bookings and shows"
                onPress={() => router.push('/account/notifications')}
              />
            </Section>
          ) : null}

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
              label="Help and contact"
              icon="help-circle-outline"
              onPress={() => router.push('/support')}
              accessibilityHint="Opens the support form"
            />
          </Section>

          {isAuthenticated ? (
            <Section title="Selling">
              {/* Where somebody realises they want it. Previously reachable only from the
                  website, so an existing customer on a phone had nowhere to start. */}
              <ListRow
                label="Become an organizer"
                icon="briefcase-outline"
                accessibilityHint="Set up an organization so you can sell tickets"
                onPress={() => router.push('/account/become-organizer')}
              />
            </Section>
          ) : null}

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

          <View className="items-center gap-2 px-4 pt-4">
            <BrandMark />
            <Text variant="meta" tone="muted">
              ETicketsGo {Constants.expoConfig?.version ?? '-'}
            </Text>
            {/* The environment is worth surfacing on non-production builds: it is the
                first question in every "it works on mine" support thread. */}
            {env.env !== 'production' ? (
              <Text variant="eyebrow" tone="muted">
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
    <View className="gap-2.5">
      <Text variant="eyebrow" tone="muted" className="px-4" accessibilityRole="header">
        {title}
      </Text>
      <ListGroup className="mx-4">{children}</ListGroup>
    </View>
  );
}

/** "Riya Rao" -> "RR"; a single name gives one letter. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}
