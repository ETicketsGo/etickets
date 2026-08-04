import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '@/theme';
import { Badge, Text, haptics } from '@/ui';
import { formatDateTime, formatMoney } from '@/services/locale';
import type { EventSummary, MovieSummary } from './schema';

/**
 * Fade-in on load rather than a spinner: posters arrive fast enough that a spinner is
 * a flash of noise, and a blurhash placeholder would need the API to send one.
 */
const IMAGE_TRANSITION = 180;

/** Horizontal card for a shelf ("Trending", "This weekend"). */
export function EventCard({ event, width = 260 }: { event: EventSummary; width?: number }) {
  const router = useRouter();
  const { colors } = useTheme();
  const price =
    event.fromPriceMinor != null ? formatMoney(event.fromPriceMinor, event.currency) : null;
  const when = event.nextSessionAt ? formatDateTime(event.nextSessionAt) : 'Dates to be announced';

  return (
    <Pressable
      accessibilityRole="button"
      // One announcement carrying everything a sighted user gets from the card. Without
      // it a screen reader reads four disconnected fragments and the user has to
      // assemble the event themselves.
      accessibilityLabel={[
        event.title,
        event.category,
        `at ${event.venue.name}, ${event.venue.city}`,
        when,
        price ? `from ${price}` : null,
      ]
        .filter(Boolean)
        .join('. ')}
      accessibilityHint="Opens event details"
      onPress={() => {
        haptics.tap();
        router.push({ pathname: '/event/[slug]', params: { slug: event.slug } });
      }}
      style={{ width }}
      className="gap-2 active:opacity-70"
    >
      <View className="h-32 items-center justify-center rounded-md border border-border bg-background-subtle">
        {/* The events API returns no artwork, so the category glyph stands in rather
            than a broken-image box. Swap for <Image> when the API carries one. */}
        <Ionicons name={categoryIcon(event.category)} size={30} color={colors.textMuted} />
      </View>

      <View className="gap-0.5">
        <Text variant="headline" numberOfLines={2}>
          {event.title}
        </Text>
        <Text variant="footnote" tone="muted" numberOfLines={1}>
          {event.venue.name}, {event.venue.city}
        </Text>
        <Text variant="footnote" tone="muted" numberOfLines={1}>
          {when}
        </Text>
        {price ? (
          <Text variant="subhead" className="mt-0.5 font-semibold">
            {price}
            <Text variant="footnote" tone="muted">
              {' '}
              onwards
            </Text>
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Full-width row for search results, where vertical density matters more than artwork. */
export function EventRow({ event }: { event: EventSummary }) {
  const router = useRouter();
  const { colors } = useTheme();
  const price =
    event.fromPriceMinor != null ? formatMoney(event.fromPriceMinor, event.currency) : null;
  const when = event.nextSessionAt ? formatDateTime(event.nextSessionAt) : 'Dates to be announced';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        event.title,
        event.category,
        `at ${event.venue.name}, ${event.venue.city}`,
        when,
        price ? `from ${price}` : null,
      ]
        .filter(Boolean)
        .join('. ')}
      accessibilityHint="Opens event details"
      onPress={() => {
        haptics.tap();
        router.push({ pathname: '/event/[slug]', params: { slug: event.slug } });
      }}
      className="flex-row items-center gap-3 px-5 py-3 active:bg-background-subtle"
    >
      <View className="h-14 w-14 items-center justify-center rounded-sm bg-background-subtle">
        <Ionicons name={categoryIcon(event.category)} size={22} color={colors.textMuted} />
      </View>
      <View className="flex-1 gap-0.5">
        <Text variant="callout" className="font-semibold" numberOfLines={1}>
          {event.title}
        </Text>
        <Text variant="footnote" tone="muted" numberOfLines={1}>
          {event.venue.city} · {when}
        </Text>
      </View>
      {price ? (
        <Text variant="subhead" className="font-semibold">
          {price}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Poster card for cinema. Movies do carry artwork, so this one renders a real image. */
export function MovieCard({ movie, width = 132 }: { movie: MovieSummary; width?: number }) {
  const router = useRouter();
  const { colors } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        movie.title,
        movie.certificate ? `rated ${movie.certificate}` : null,
        movie.language,
        movie.genres.join(', ') || null,
        movie.runtimeMinutes ? `${movie.runtimeMinutes} minutes` : null,
      ]
        .filter(Boolean)
        .join('. ')}
      accessibilityHint="Opens showtimes"
      onPress={() => {
        haptics.tap();
        router.push({ pathname: '/movie/[slug]', params: { slug: movie.slug } });
      }}
      style={{ width }}
      className="gap-2 active:opacity-70"
    >
      <View
        style={{ aspectRatio: 2 / 3 }}
        className="overflow-hidden rounded-md border border-border bg-background-subtle"
      >
        {movie.posterUrl ? (
          <Image
            source={{ uri: movie.posterUrl }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={IMAGE_TRANSITION}
            // The Pressable already announces the title; a duplicate alt would read twice.
            accessible={false}
            // Posters are immutable once published, so they can be cached hard.
            cachePolicy="memory-disk"
          />
        ) : (
          <View className="flex-1 items-center justify-center">
            <Ionicons name="film-outline" size={26} color={colors.textMuted} />
          </View>
        )}
      </View>
      <View className="gap-0.5">
        <Text variant="subhead" className="font-semibold" numberOfLines={2}>
          {movie.title}
        </Text>
        <View className="flex-row items-center gap-1.5">
          {movie.certificate ? <Badge label={movie.certificate} /> : null}
          {movie.language ? (
            <Text variant="caption" tone="muted" numberOfLines={1} className="flex-1">
              {movie.language}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** Maps a free-text category to a glyph, with a neutral fallback for unknown ones. */
export function categoryIcon(category: string): keyof typeof Ionicons.glyphMap {
  switch (category.toLowerCase()) {
    case 'music':
    case 'concert':
      return 'musical-notes-outline';
    case 'comedy':
      return 'happy-outline';
    case 'tech':
    case 'conference':
      return 'laptop-outline';
    case 'sports':
      return 'football-outline';
    case 'theatre':
    case 'theater':
      return 'color-palette-outline';
    case 'workshop':
      return 'construct-outline';
    default:
      return 'calendar-outline';
  }
}
