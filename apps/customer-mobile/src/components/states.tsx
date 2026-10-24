import { type ReactNode, useEffect } from 'react';
import { ActivityIndicator, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { palette } from '@/theme';
import { Button, Text } from '@/ui';

/**
 * The reusable screen states: Loading, Skeleton, Empty, Error, Offline. Accessible (roles
 * and live regions) and in the storefront's paper and ink.
 */

export function LoadingState({ label = 'Loading...' }: { label?: string }) {
  return (
    <View
      className="flex-1 items-center justify-center gap-3"
      accessibilityRole="progressbar"
      accessibilityLabel={label}
    >
      <ActivityIndicator size="large" color={palette.text} />
      <Text variant="ui" tone="muted">
        {label}
      </Text>
    </View>
  );
}

/** Pulsing block in the sunken paper colour; compose several to mimic a screen's layout. */
export function Skeleton({
  className = 'h-4 w-full',
  style,
}: {
  className?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const opacity = useSharedValue(0.55);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(1, { duration: 800 }), -1, true);
  }, [opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[animated, style]}
      className={`rounded-control bg-sunken ${className}`}
    />
  );
}

function CenteredState({
  icon,
  title,
  message,
  action,
  tone = 'muted',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  message?: string;
  action?: ReactNode;
  tone?: 'muted' | 'error';
}) {
  return (
    <View
      className="flex-1 items-center justify-center gap-3 px-8"
      accessibilityRole="summary"
      accessibilityLabel={`${title}. ${message ?? ''}`}
    >
      <View className="mb-1 h-16 w-16 items-center justify-center rounded-full bg-sunken">
        <Ionicons
          name={icon}
          size={28}
          color={tone === 'error' ? palette.critical : palette.textSecondary}
        />
      </View>
      <Text variant="d3" className="text-center">
        {title}
      </Text>
      {message ? (
        <Text variant="body" tone="secondary" className="text-center">
          {message}
        </Text>
      ) : null}
      {action ? <View className="mt-2">{action}</View> : null}
    </View>
  );
}

export function EmptyState(props: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return <CenteredState {...props} icon={props.icon ?? 'file-tray-outline'} />;
}

export function ErrorState({
  title = 'Something went wrong',
  message = 'Please try again.',
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <CenteredState
      icon="alert-circle-outline"
      tone="error"
      title={title}
      message={message}
      action={onRetry ? <RetryButton onPress={onRetry} /> : undefined}
    />
  );
}

export function OfflineState({ onRetry }: { onRetry?: () => void }) {
  return (
    <CenteredState
      icon="cloud-offline-outline"
      title="You are offline"
      message="Check your connection and try again."
      action={onRetry ? <RetryButton onPress={onRetry} label="Retry" /> : undefined}
    />
  );
}

/** Thin offline banner for screens that still show saved content. */
export function OfflineBanner() {
  return (
    <View
      accessibilityRole="alert"
      className="flex-row items-center justify-center gap-2 bg-caution-tint px-4 py-2"
    >
      <Ionicons name="cloud-offline-outline" size={15} color={palette.goldText} />
      <Text variant="meta" className="font-medium">
        You are offline. Showing what is saved on this phone.
      </Text>
    </View>
  );
}

function RetryButton({ onPress, label = 'Try again' }: { onPress: () => void; label?: string }) {
  return <Button label={label} variant="secondary" fullWidth={false} onPress={onPress} />;
}
