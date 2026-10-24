import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Button, StageTag, Text, haptics } from '@/ui';
import { formatEventWhen, formatMoney } from '@/services/locale';
import { EventPicture } from '@/features/events/event-picture';
import { EventArtworkFallback } from '@/features/events/event-artwork';
import { ContentLabelPill } from '@/features/events/content-label';
import type { EventSummary, MovieSummary } from './schema';

/**
 * The storefront's event cards (DESIGN-SYSTEM.md section 4): the picture on top or at the
 * left, then an eyebrow (category), the title in the display face, one meta line (date,
 * venue), and the price as "From Rs X". No card border: the photo is the edge.
 */

const IMAGE_TRANSITION = 180;

function eventFacts(event: EventSummary) {
  const tz = event.venue.timezone ?? undefined;
  const when = event.nextSessionAt ? formatEventWhen(event.nextSessionAt, tz) : null;
  const price =
    event.fromPriceMinor != null
      ? event.fromPriceMinor === 0
        ? 'Free'
        : formatMoney(event.fromPriceMinor, event.currency)
      : null;
  const where = `${event.venue.name}, ${event.venue.city}`;
  // One announcement carrying everything a sighted customer gets from the card.
  const label = [
    event.title,
    event.category,
    when ?? 'Dates to be announced',
    `at ${where}`,
    price ? (price === 'Free' ? 'Free' : `from ${price}`) : null,
  ]
    .filter(Boolean)
    .join('. ');
  return { when, price, where, label };
}

function useOpenEvent(slug: string) {
  const router = useRouter();
  return () => {
    haptics.tap();
    router.push({ pathname: '/event/[slug]', params: { slug } });
  };
}

function Price({ price, onStage = false }: { price: string | null; onStage?: boolean }) {
  if (!price) return null;
  if (price === 'Free') {
    return (
      <Text variant="ui" tone={onStage ? 'onStage' : 'primary'} className="font-semibold">
        Free
      </Text>
    );
  }
  return (
    <Text variant="ui" tone={onStage ? 'onStage2' : 'muted'}>
      From{' '}
      <Text variant="body" tone={onStage ? 'onStage' : 'primary'} className="font-bold" tabular>
        {price}
      </Text>
    </Text>
  );
}

function EyebrowLine({ event }: { event: EventSummary }) {
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <Text variant="eyebrow" tone="gold">
        {event.category}
      </Text>
      <ContentLabelPill label={event.contentLabel} />
    </View>
  );
}

/** A rail card: 4:3 picture, then the text block. */
export function EventCard({ event, width = 260 }: { event: EventSummary; width?: number }) {
  const facts = eventFacts(event);
  const open = useOpenEvent(event.slug);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={facts.label}
      accessibilityHint="Opens the event"
      onPress={open}
      style={{ width }}
      className="gap-2.5 active:opacity-80"
    >
      <EventPicture
        event={event}
        use="card"
        className="rounded-card"
        fallback={<EventArtworkFallback title={event.title} category={event.category} />}
      />
      <View className="gap-1">
        <EyebrowLine event={event} />
        <Text variant="card" numberOfLines={2}>
          {event.title}
        </Text>
        <Text variant="meta" tone="muted" numberOfLines={2}>
          {facts.when ? `${facts.when} - ` : ''}
          {facts.where}
        </Text>
        <Price price={facts.price} />
      </View>
    </Pressable>
  );
}

/** The first event of a section, full width: 16:9 picture, bigger title. */
export function FeaturedEventCard({ event }: { event: EventSummary }) {
  const facts = eventFacts(event);
  const open = useOpenEvent(event.slug);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={facts.label}
      accessibilityHint="Opens the event"
      onPress={open}
      className="gap-3 active:opacity-80"
    >
      <EventPicture
        event={event}
        use="banner"
        className="rounded-card"
        fallback={<EventArtworkFallback title={event.title} category={event.category} />}
      />
      <View className="gap-1.5">
        <EyebrowLine event={event} />
        <Text variant="d3" numberOfLines={2}>
          {event.title}
        </Text>
        <Text variant="body" tone="secondary" numberOfLines={2}>
          {facts.when ? (
            <Text variant="body" className="font-semibold">
              {facts.when}
            </Text>
          ) : null}
          {facts.when ? ' - ' : ''}
          {facts.where}
        </Text>
        <Price price={facts.price} />
      </View>
    </Pressable>
  );
}

/** The storefront's list row: a 4:3 thumbnail at the left, the text block at the right. */
export function EventRow({ event }: { event: EventSummary }) {
  const facts = eventFacts(event);
  const open = useOpenEvent(event.slug);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={facts.label}
      accessibilityHint="Opens the event"
      onPress={open}
      className="flex-row gap-3.5 py-4 active:opacity-80"
    >
      <View style={{ width: 112 }} className="pt-1">
        <EventPicture
          event={event}
          use="card"
          className="rounded-[12px]"
          fallback={<EventArtworkFallback title={event.title} compact />}
        />
      </View>
      <View className="flex-1 gap-1">
        <EyebrowLine event={event} />
        <Text variant="card" numberOfLines={2}>
          {event.title}
        </Text>
        <Text variant="meta" tone="muted" numberOfLines={2}>
          {facts.when ? `${facts.when} - ` : ''}
          {facts.where}
        </Text>
        <Price price={facts.price} />
      </View>
    </Pressable>
  );
}

/**
 * A film poster (2:3). On the storefront the "Now showing" rail sits on a stage band, so
 * the card has a paper version and a stage version.
 */
export function MovieCard({
  movie,
  width = 150,
  onStage = false,
}: {
  movie: MovieSummary;
  width?: number;
  onStage?: boolean;
}) {
  const router = useRouter();
  const meta = [movie.language, movie.runtimeMinutes ? `${movie.runtimeMinutes} min` : null]
    .filter(Boolean)
    .join(' - ');

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
      className="gap-2.5 active:opacity-80"
    >
      <View
        style={{ aspectRatio: 2 / 3 }}
        className={`overflow-hidden rounded-card border ${
          onStage ? 'border-stage-line-strong' : 'border-border'
        } bg-image-fallback`}
      >
        {movie.posterUrl ? (
          <Image
            source={{ uri: movie.posterUrl }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={IMAGE_TRANSITION}
            accessible={false}
            cachePolicy="memory-disk"
          />
        ) : (
          <EventArtworkFallback title={movie.title} category="Film" />
        )}
      </View>
      <View className="gap-1.5">
        <Text variant="card" tone={onStage ? 'onStage' : 'primary'} numberOfLines={2}>
          {movie.title}
        </Text>
        <View className="flex-row flex-wrap gap-1.5">
          <ContentLabelPill label={movie.contentLabel} onStage={onStage} />
          {movie.certificate ? (
            onStage ? (
              <StageTag label={movie.certificate} />
            ) : (
              <View
                className="justify-center rounded-full border border-border-strong px-2"
                style={{ minHeight: 22 }}
              >
                <Text variant="meta" tone="secondary" className="font-medium">
                  {movie.certificate}
                </Text>
              </View>
            )
          ) : null}
        </View>
        {meta ? (
          <Text variant="meta" tone={onStage ? 'onStage3' : 'muted'} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * The storefront's hero: one event on a stage band, its picture behind a scrim from the
 * text side, the gold "Book tickets" (the single gold moment on the page) and its price.
 */
export function StageHero({ event }: { event: EventSummary }) {
  const facts = eventFacts(event);
  const open = useOpenEvent(event.slug);
  const eyebrow = [event.category, event.venue.city].filter(Boolean).join(' / ');
  const date = facts.when?.split(', ');

  return (
    <View className="overflow-hidden bg-stage" style={{ minHeight: 470 }}>
      <View className="absolute inset-0">
        <EventPicture event={event} use="banner" className="h-full w-full" fallback={null} />
      </View>
      {/* The scrim: text sits only over the darkened side, never over the focal point. */}
      <LinearGradient
        colors={['rgba(22,19,15,0.15)', 'rgba(22,19,15,0.72)', 'rgba(22,19,15,0.96)']}
        locations={[0, 0.45, 1]}
        style={{ position: 'absolute', inset: 0 }}
      />
      <View className="flex-1 justify-end gap-3 px-4 pb-7 pt-28">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text variant="eyebrow" tone="goldOnStage">
            {eyebrow}
          </Text>
          <ContentLabelPill label={event.contentLabel} onStage />
        </View>
        <Text variant="hero" tone="onStage" numberOfLines={3}>
          {event.title}
        </Text>
        {date ? (
          <Text variant="lead" tone="onStage2">
            <Text variant="lead" tone="onStage" className="font-semibold">
              {date[0]}
            </Text>{' '}
            {date[1]}
          </Text>
        ) : null}
        <Text variant="body" tone="onStage2" numberOfLines={2}>
          <Text variant="body" tone="onStage" className="font-semibold">
            {event.venue.name}
          </Text>{' '}
          {event.venue.city}
        </Text>
        {event.organizer ? (
          <Text variant="body" tone="onStage3" numberOfLines={1}>
            By {event.organizer}
          </Text>
        ) : null}
        <View className="mt-2 flex-row items-center gap-5">
          <Button
            label="Book tickets"
            variant="gold"
            size="lg"
            fullWidth={false}
            onPress={open}
            accessibilityLabel={`Book tickets, ${event.title}`}
          />
          <Price price={facts.price} onStage />
        </View>
      </View>
    </View>
  );
}
