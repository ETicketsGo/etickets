import { Stack, useRouter } from 'expo-router';
import { Screen } from '@/components/screen';
import { EmptyState } from '@/components/states';
import { Button } from '@/ui';

/** A link to something that is not here: say so, and offer the way home. */
export default function NotFound() {
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen>
        <EmptyState
          icon="compass-outline"
          title="This page is not here"
          message="The link may be old, or the event may have ended."
          action={
            <Button
              label="Go to Home"
              fullWidth={false}
              onPress={() => router.replace('/(tabs)')}
            />
          }
        />
      </Screen>
    </>
  );
}
