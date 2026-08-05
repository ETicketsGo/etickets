import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './text';
import { haptics } from './haptics';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

const TONE: Record<BadgeTone, { box: string; text: 'muted' | 'accent' | 'success' | 'danger' }> = {
  neutral: { box: 'bg-background-subtle', text: 'muted' },
  accent: { box: 'bg-action-primary/12', text: 'accent' },
  success: { box: 'bg-status-success/12', text: 'success' },
  warning: { box: 'bg-status-warning/15', text: 'muted' },
  error: { box: 'bg-status-error/12', text: 'danger' },
};

/** Small non-interactive status pill — "Confirmed", "3 left", "Sold out". */
export function Badge({
  label,
  tone = 'neutral',
  className = '',
}: {
  label: string;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <View className={`self-start rounded-full px-2 py-1 ${TONE[tone].box} ${className}`}>
      <Text variant="caption" tone={TONE[tone].text} className="font-semibold">
        {label}
      </Text>
    </View>
  );
}

/**
 * Interactive filter chip. Selection is carried in `accessibilityState.selected`, not
 * only in colour, so it survives both a screen reader and a colour-vision deficiency.
 */
export function Chip({
  label,
  selected = false,
  onPress,
  icon,
  className = '',
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  className?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={() => {
        haptics.select();
        onPress();
      }}
      style={{ minHeight: 36 }}
      hitSlop={6}
      className={[
        'flex-row items-center gap-1.5 rounded-full border px-3.5 active:opacity-70',
        selected
          ? 'border-action-primary bg-action-primary'
          : 'border-border bg-background-surface',
        className,
      ].join(' ')}
    >
      {icon ? <Ionicons name={icon} size={14} color={selected ? '#FFFFFF' : undefined} /> : null}
      <Text
        variant="subhead"
        tone={selected ? 'onAccent' : 'secondary'}
        className={selected ? 'font-semibold' : ''}
      >
        {label}
      </Text>
    </Pressable>
  );
}
