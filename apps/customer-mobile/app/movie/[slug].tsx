import { ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/components/screen';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/states';
import { useOnline } from '@/hooks/use-online';
import { useTheme } from '@/theme';
import { Badge, Button, Card, IconButton, Text } from '@/ui';
import { useDiscovery } from '@/features/discovery/api';
import { CINEMA_CAPABILITIES } from '@/features/cinema/capability';

/**
 * Movie detail.
 *
 * Everything above the showtimes block is real data from /public/discovery — title,
 * poster, certificate, language, genres, runtime. The showtimes block is a declared
 * boundary rather than a list, because no public endpoint maps a movie to its bookable
 * screenings. See src/features/cinema/capability.ts for the verification and for the
 * two candidate contracts that would close it.
 *
 * The alternative — inventing showtimes, or quietly linking nowhere — was rejected. A
 * user who is told plainly that booking is on the website can complete their purchase;
 * one who taps a dead button cannot.
 */
export default function MovieScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const online = useOnline();
  const { colors } = useTheme();
  const { data, isPending, isError, refetch } = useDiscovery();

  const movie = data?.nowShowing.find((m) => m.slug === slug);

  return (
    <Screen padded={false} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      {!online ? <OfflineBanner /> : null}

      <View className="flex-row items-center gap-1 px-2 py-1">
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
        />
        <Text variant="callout" className="flex-1 font-semibold" numberOfLines={1}>
          {movie?.title ?? 'Movie'}
        </Text>
      </View>

      {isPending ? (
        <LoadingState label="Loading…" />
      ) : isError ? (
        <ErrorState
          title="Couldn't load this film"
          message={online ? 'Please try again.' : "You're offline. Reconnect and try again."}
          onRetry={() => void refetch()}
        />
      ) : !movie ? (
        <ErrorState
          title="Film not found"
          message="It may no longer be showing."
          onRetry={() => router.replace('/(tabs)')}
        />
      ) : (
        <ScrollView contentContainerClassName="gap-5 px-5 pb-8 pt-2">
          <View className="flex-row gap-4">
            <View
              style={{ width: 116, aspectRatio: 2 / 3 }}
              className="overflow-hidden rounded-md border border-border bg-background-subtle"
            >
              {movie.posterUrl ? (
                <Image
                  source={{ uri: movie.posterUrl }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="cover"
                  transition={180}
                  cachePolicy="memory-disk"
                  accessible={false}
                />
              ) : (
                <View className="flex-1 items-center justify-center">
                  <Ionicons name="film-outline" size={28} color={colors.textMuted} />
                </View>
              )}
            </View>

            <View className="flex-1 gap-2">
              <Text variant="title2" accessibilityRole="header">
                {movie.title}
              </Text>
              <View className="flex-row flex-wrap gap-1.5">
                {movie.certificate ? <Badge label={movie.certificate} tone="accent" /> : null}
                {movie.language ? <Badge label={movie.language} /> : null}
                {movie.runtimeMinutes ? (
                  <Badge label={formatRuntime(movie.runtimeMinutes)} />
                ) : null}
              </View>
              {movie.genres.length > 0 ? (
                <Text variant="subhead" tone="muted">
                  {movie.genres.join(' · ')}
                </Text>
              ) : null}
            </View>
          </View>

          <View className="gap-2">
            <Text variant="title3" accessibilityRole="header">
              Showtimes
            </Text>

            {CINEMA_CAPABILITIES.publicShowtimesByMovie ? (
              // Intentionally unreachable today. When the capability flips, the
              // showtimes list replaces this whole branch.
              <Card>
                <Text variant="subhead" tone="muted">
                  Loading showtimes…
                </Text>
              </Card>
            ) : (
              <Card className="gap-3">
                <View className="flex-row items-start gap-2">
                  <Ionicons name="information-circle-outline" size={18} color={colors.textMuted} />
                  <Text variant="subhead" tone="secondary" className="flex-1">
                    Cinema showtimes aren&rsquo;t bookable in the app yet. Seat selection is built
                    and working — it&rsquo;s the link from a film to its screenings that the API
                    doesn&rsquo;t expose publicly.
                  </Text>
                </View>
                <Text variant="footnote" tone="muted">
                  You can book this film on the ETicketsGo website in the meantime.
                </Text>
                <Button
                  label="Browse events instead"
                  variant="secondary"
                  onPress={() => router.replace('/(tabs)')}
                />
              </Card>
            )}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

/** 124 → "2h 4m". Whole hours drop the minutes: "2h", not "2h 0m". */
function formatRuntime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
