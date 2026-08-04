import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { Screen } from '@/components/screen';
import { EmptyState } from '@/components/states';
import { Button, IconButton, Text } from '@/ui';

/**
 * Cinema showtimes and seat selection.
 *
 * NOT BUILT YET. This route exists because Home links to it from the "Now showing"
 * shelf, and a link that silently does nothing is worse than one that says so.
 *
 * What it needs: GET /movies/:movieId/shows for the showtime list, then
 * GET /public/shows/:sessionId/seats and GET /screens/:screenId/seatmap for the
 * reserved-seating picker. That picker is the substantial piece — a pannable, zoomable
 * seat map with per-seat availability and a hold on selection — and it is a different
 * shape of work from the general-admission quantity flow that event booking uses, which
 * is why it is sequenced separately rather than half-built here.
 */
export default function MovieScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();

  return (
    <Screen padded={false} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center gap-1 px-2 py-1">
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
        />
        <Text variant="callout" className="flex-1 font-semibold" numberOfLines={1}>
          Showtimes
        </Text>
      </View>

      <EmptyState
        icon="film-outline"
        title="Cinema booking is coming soon"
        message={`Showtimes and seat selection for this film aren't available in the app yet. You can book "${slug ?? ''}" on the website in the meantime.`}
        action={
          <Button
            label="Browse events"
            fullWidth={false}
            onPress={() => router.replace('/(tabs)')}
          />
        }
      />
    </Screen>
  );
}
