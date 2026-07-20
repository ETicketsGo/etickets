import { useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/hooks/use-auth';
import { registerForPush } from '@/services/notifications';

/** Authenticated area. Guards against unauthenticated access and registers push. */
export default function AppLayout() {
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (isAuthenticated) void registerForPush();
  }, [isAuthenticated]);

  if (!isAuthenticated) return <Redirect href="/(auth)/welcome" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
