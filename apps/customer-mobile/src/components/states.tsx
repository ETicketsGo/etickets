import { type ReactNode, useEffect } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme';

/**
 * The five reusable screen states every screen composes: Loading, Skeleton, Empty,
 * Error, Offline. All are accessible (roles + live regions) and theme-aware.
 */

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  const { colors } = useTheme();
  return (
    <View
      className="flex-1 items-center justify-center gap-3"
      accessibilityRole="progressbar"
      accessibilityLabel={label}
    >
      <ActivityIndicator size="large" color={colors.primary} />
      <Text className="text-text-muted">{label}</Text>
    </View>
  );
}

/** Pulsing skeleton block; compose several to mimic a screen's layout while loading. */
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  const opacity = useSharedValue(0.5);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(1, { duration: 800 }), -1, true);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={style}
      className={`rounded-md bg-background-subtle ${className}`}
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
  const { colors } = useTheme();
  return (
    <View
      className="flex-1 items-center justify-center gap-3 px-8"
      accessibilityRole="summary"
      accessibilityLabel={`${title}. ${message ?? ''}`}
    >
      <Ionicons name={icon} size={40} color={tone === 'error' ? '#DC2626' : colors.textMuted} />
      <Text className="text-center text-lg font-semibold text-text-primary">{title}</Text>
      {message ? <Text className="text-center text-text-muted">{message}</Text> : null}
      {action}
    </View>
  );
}

export function EmptyState(props: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return <CenteredState icon={props.icon ?? 'file-tray-outline'} {...props} />;
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
      title="You're offline"
      message="Check your connection and try again."
      action={onRetry ? <RetryButton onPress={onRetry} label="Retry" /> : undefined}
    />
  );
}

/** Thin inline offline banner for screens that still show cached content. */
export function OfflineBanner() {
  return (
    <View
      accessibilityRole="alert"
      className="flex-row items-center justify-center gap-2 bg-status-warning/15 py-2"
    >
      <Ionicons name="cloud-offline-outline" size={14} color="#D97706" />
      <Text className="text-caption text-status-warning">You're offline — showing saved data.</Text>
    </View>
  );
}

function RetryButton({ onPress, label = 'Try again' }: { onPress: () => void; label?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="mt-2 rounded-md bg-action-primary px-4 py-2 active:opacity-80"
    >
      <Text className="font-semibold text-action-primary-foreground">{label}</Text>
    </Pressable>
  );
}
