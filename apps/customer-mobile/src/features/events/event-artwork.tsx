import { View } from 'react-native';
import { Text } from '@/ui';

/**
 * The storefront's no-image fallback (DESIGN-SYSTEM.md section 6): the event's own title in
 * the display face on the stage tone, the category as an eyebrow, a short gold rule. Never a
 * letter on a colour square, never a generic icon tile, never a stock photo standing in for
 * the organizer's.
 */
export function EventArtworkFallback({
  title,
  category,
  compact = false,
}: {
  title: string;
  category?: string | null;
  compact?: boolean;
}) {
  return (
    <View className="flex-1 justify-end bg-image-fallback" style={{ padding: compact ? 8 : 14 }}>
      {category && !compact ? (
        <Text variant="eyebrow" tone="goldOnStage" numberOfLines={1}>
          {category}
        </Text>
      ) : null}
      <Text
        variant={compact ? 'meta' : 'card'}
        tone="onStage"
        numberOfLines={compact ? 3 : 2}
        className={compact ? 'font-bold' : 'mt-1'}
      >
        {title}
      </Text>
      <View className="mt-2 h-[2px] w-6 bg-gold" />
    </View>
  );
}
