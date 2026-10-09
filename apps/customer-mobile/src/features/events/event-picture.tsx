import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { env } from '@/services/env';
import {
  EVENT_IMAGE_ASPECT,
  eventImageUrl,
  type EventImageSource,
  type EventImageUse,
} from './event-image';

/** Fade-in on load, as the movie posters do: a spinner on a fast image is a flash of noise. */
const IMAGE_TRANSITION = 180;

/**
 * An event's picture in a box of the shape its copy was cut to, or `fallback` when there is
 * no picture or it cannot be loaded.
 *
 * The box keeps its shape either way, so a shelf where some events have a picture and some do
 * not still lines up, and a picture arriving late does not push the text below it down.
 */
export function EventPicture({
  event,
  use,
  fallback,
  className,
}: {
  event: EventImageSource;
  use: EventImageUse;
  /** What the box shows without a picture. Null leaves it out entirely. */
  fallback: ReactNode | null;
  className?: string;
}) {
  const url = eventImageUrl(event, use, env.apiUrl);
  // A failed load (a deleted upload, no network) shows the fallback, not a blank box.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const show = url !== null && url !== failedUrl;

  if (!show && fallback === null) return null;
  return (
    <View
      style={{ aspectRatio: EVENT_IMAGE_ASPECT[use] }}
      className={`overflow-hidden bg-background-subtle ${className ?? ''}`}
      testID={show ? 'event-picture' : 'event-picture-fallback'}
    >
      {show ? (
        <Image
          source={{ uri: url }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={IMAGE_TRANSITION}
          // Whatever contains the picture already announces the event; a duplicate alt reads twice.
          accessible={false}
          // The URL carries a version that changes when the picture or its crop does.
          cachePolicy="memory-disk"
          onError={() => setFailedUrl(url)}
          testID="event-picture-image"
        />
      ) : (
        <View className="flex-1 items-center justify-center">{fallback}</View>
      )}
    </View>
  );
}
