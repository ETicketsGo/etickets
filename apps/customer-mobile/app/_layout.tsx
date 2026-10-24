import '../global.css';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import {
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
  BricolageGrotesque_800ExtraBold,
} from '@expo-google-fonts/bricolage-grotesque';
import { palette } from '@/theme';
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
    // The storefront's display face (DESIGN-SYSTEM.md section 2): titles only. Bundled
    // into the binary by the package, so nothing is fetched from Google at run time.
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
    BricolageGrotesque_800ExtraBold,
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
      {/* iOS pushes slide like every other iPhone app; Android keeps the fade it has always had. */}
      <Stack
        screenOptions={{
          headerShown: false,
          animation: Platform.OS === 'ios' ? 'default' : 'fade',
          // Paper behind every screen, so a transition never flashes white.
          contentStyle: { backgroundColor: palette.canvas },
        }}
      >
        <Stack.Screen name="index" options={{ animation: 'fade' }} />
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
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
