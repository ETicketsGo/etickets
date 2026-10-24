import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { palette } from '@/theme';
import { Text, type TextTone } from './text';
import { haptics } from './haptics';

export type BadgeTone = 'neutral' | 'accent' | 'live' | 'success' | 'warning' | 'error' | 'info';

/**
 * The storefront's status pill (web-kit `BrandStatusPill`): 24px, words always, a tint with
 * its own strong text. `live` (gold, ink words) is only for Today / On sale now / Doors open.
 */
const TONE: Record<BadgeTone, { box: string; text: TextTone }> = {
  neutral: { box: 'bg-sunken', text: 'secondary' },
  accent: { box: 'bg-sunken', text: 'primary' },
  live: { box: 'bg-gold', text: 'primary' },
  success: { box: 'bg-positive-tint', text: 'success' },
  warning: { box: 'bg-caution-tint', text: 'gold' },
  error: { box: 'bg-critical-tint', text: 'danger' },
  info: { box: 'bg-info-tint', text: 'primary' },
};

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
    <View
      style={{ minHeight: 24 }}
      className={`self-start justify-center rounded-full px-2.5 ${TONE[tone].box} ${className}`}
    >
      <Text variant="meta" tone={TONE[tone].text} className="font-semibold">
        {label}
      </Text>
    </View>
  );
}

/**
 * Filter chip (web-kit `brandChipClasses`): a 36px pill, hairline when off, INK FILL when
 * selected. Selection is also carried in `accessibilityState.selected`, not only in colour.
 * `tone="stage"` is the outlined chip on a dark band (certificate, language).
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
        'flex-row items-center gap-1.5 rounded-full border px-4 active:opacity-70',
        selected ? 'border-ink bg-ink' : 'border-border-strong bg-background-surface',
        className,
      ].join(' ')}
    >
      {icon ? (
        <Ionicons name={icon} size={15} color={selected ? palette.onPrimary : palette.text} />
      ) : null}
      <Text variant="ui" tone={selected ? 'onAccent' : 'primary'} className="font-medium">
        {label}
      </Text>
    </Pressable>
  );
}

/** A non-interactive outlined tag on a stage band: "UA13+", "Kannada", "2h 18m". */
export function StageTag({
  label,
  icon,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View
      style={{ minHeight: 30 }}
      className="flex-row items-center gap-1.5 self-start rounded-full border border-stage-line-strong px-3"
    >
      {icon ? <Ionicons name={icon} size={14} color="#CFC7BA" /> : null}
      <Text variant="meta" tone="onStage2" className="font-medium">
        {label}
      </Text>
    </View>
  );
}
