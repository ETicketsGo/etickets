import '../global.css';
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { AppProviders } from '@/components/providers';
import { useAuthStore } from '@/application/auth-store';
import { initSentry, Sentry } from '@/services/sentry';
import { useDeepLinks } from '@/hooks/use-deep-links';

initSentry();
SplashScreen.preventAutoHideAsync().catch(() => undefined);

function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter: Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const status = useAuthStore((s) => s.status);
  const hydrate = useAuthStore((s) => s.hydrate);

  // Restore the session from secure storage on launch.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Hold the splash until fonts are ready and the session is resolved.
  const ready = fontsLoaded && status !== 'loading';
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  if (!ready) return null;

  return (
    <AppProviders>
      <DeepLinkHandler />
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(tabs)" />
        {/* Auth is a modal presented over whatever the user was doing, so signing in
            returns them to that screen instead of resetting them to Home. */}
        <Stack.Screen
          name="(auth)"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
      </Stack>
    </AppProviders>
  );
}

// Sentry.wrap enriches crashes with routing/native context.
export default Sentry.wrap(RootLayout);

/**
 * Renders nothing; exists so the deep-link hook runs INSIDE the provider tree, where
 * the router and the auth store are available.
 */
function DeepLinkHandler() {
  useDeepLinks();
  return null;
}
