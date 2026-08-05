import { useEffect, type ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider, onlineManager, focusManager } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';
import { queryClient } from '@/application/query-client';
import { useAuthStore } from '@/application/auth-store';
import { setOnAuthExpired } from '@/services/api-client';
import { ErrorBoundary } from './error-boundary';

// Bridge React Query's online/focus managers to React Native (NetInfo + AppState).
onlineManager.setEventListener((setOnline) =>
  NetInfo.addEventListener((state) => setOnline(Boolean(state.isConnected))),
);

/** Composes every app-wide provider in the correct order. */
export function AppProviders({ children }: { children: ReactNode }) {
  useEffect(() => {
    // When the API client can't refresh, force the auth store to log out.
    setOnAuthExpired(() => useAuthStore.getState().expire());

    const sub = AppState.addEventListener('change', (status: AppStateStatus) =>
      focusManager.setFocused(status === 'active'),
    );
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ErrorBoundary>{children}</ErrorBoundary>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
