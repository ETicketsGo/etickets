import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/theme';
import { Button, Text } from '@/ui';
import { LoadingState } from './states';

/**
 * Wraps the parts of the app that genuinely need an account — tickets, profile,
 * anything reading `/users/me`.
 *
 * It renders a sign-in prompt IN PLACE rather than redirecting to the auth stack. The
 * difference matters: a redirect throws away where the user was, so after signing in
 * they land on Home and have to find their way back. Here the tab stays put, the user
 * signs in on a modal, and the content they asked for renders underneath.
 *
 * Discovery, event detail, seat selection and guest checkout are deliberately NOT
 * wrapped — the API serves them publicly and an account is only required at the point
 * where a booking becomes attached to a person.
 */
export function AuthGate({
  children,
  title,
  message,
}: {
  children: ReactNode;
  title: string;
  message: string;
}) {
  const { isAuthenticated, status } = useAuth();
  const router = useRouter();
  const { colors } = useTheme();

  // 'loading' is the pre-hydration state. Showing the sign-in prompt during it would
  // flash "Sign in" at a user who is already signed in, every cold start.
  if (status === 'loading') return <LoadingState label="Loading your account…" />;
  if (isAuthenticated) return <>{children}</>;

  return (
    <View className="flex-1 items-center justify-center gap-3 px-8">
      <Ionicons name="person-circle-outline" size={48} color={colors.textMuted} />
      <Text variant="title3" className="text-center">
        {title}
      </Text>
      <Text variant="subhead" tone="muted" className="text-center">
        {message}
      </Text>
      <View className="mt-3 w-full gap-2">
        <Button label="Sign in" onPress={() => router.push('/(auth)/login')} />
        <Button
          label="Create an account"
          variant="ghost"
          onPress={() => router.push('/(auth)/register')}
        />
      </View>
    </View>
  );
}
