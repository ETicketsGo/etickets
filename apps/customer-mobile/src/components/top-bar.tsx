import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { IconButton, Text } from '@/ui';

/**
 * The bar above a pushed screen (an event, a film, checkout): a round back button, an
 * optional title, optional actions on the right. On paper, or on a stage band.
 */
export function TopBar({
  title,
  right,
  onStage = false,
  onBack,
}: {
  title?: string;
  right?: ReactNode;
  onStage?: boolean;
  /** Where back goes when there is no history (a screen opened from a link). */
  onBack?: () => void;
}) {
  const router = useRouter();
  return (
    <View className="flex-row items-center gap-2 px-3 py-1.5">
      <IconButton
        icon="chevron-back"
        accessibilityLabel="Go back"
        tone={onStage ? 'onStage' : 'outlined'}
        onPress={() => {
          if (onBack) onBack();
          else if (router.canGoBack()) router.back();
          else router.replace('/(tabs)');
        }}
      />
      <Text
        variant="uiStrong"
        tone={onStage ? 'onStage' : 'primary'}
        numberOfLines={1}
        className="flex-1"
      >
        {title ?? ''}
      </Text>
      {right}
    </View>
  );
}
