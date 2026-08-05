import { ActivityIndicator, Pressable, View, type PressableProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme';
import { Text } from './text';
import { haptics } from './haptics';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const CONTAINER: Record<ButtonVariant, string> = {
  primary: 'bg-action-primary',
  secondary: 'bg-action-secondary',
  ghost: 'bg-transparent',
  danger: 'bg-action-danger',
};

const LABEL_TONE = {
  primary: 'onAccent',
  secondary: 'primary',
  ghost: 'accent',
  danger: 'onAccent',
} as const;

/**
 * Vertical padding only. Every size clears the 44pt minimum via `minHeight` below
 * rather than through padding, so a small button stays visually small while still
 * being reachable — the two are separate concerns and conflating them is how
 * "compact" variants end up failing an accessibility audit.
 */
const SIZE: Record<ButtonSize, { box: string; text: 'subhead' | 'callout' | 'headline' }> = {
  sm: { box: 'px-3 py-2 rounded-sm', text: 'subhead' },
  md: { box: 'px-4 py-3 rounded-md', text: 'callout' },
  lg: { box: 'px-5 py-4 rounded-md', text: 'headline' },
};

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Stretch to the container's width — the default for primary calls to action. */
  fullWidth?: boolean;
  className?: string;
  /** Suppress the press haptic (for repeated presses like a quantity stepper). */
  noHaptic?: boolean;
}

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  fullWidth = true,
  className = '',
  noHaptic = false,
  disabled,
  onPress,
  accessibilityLabel,
  ...rest
}: ButtonProps) {
  // A loading button is not pressable: without this, a double-tap on "Pay" submits twice.
  const inactive = Boolean(disabled) || loading;
  const iconColor = variant === 'primary' || variant === 'danger' ? '#FFFFFF' : undefined;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      // `busy` makes a screen reader announce the wait instead of silently ignoring taps.
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      // 44pt is the Apple HIG / WCAG 2.5.5 minimum target; hitSlop covers the sm variant
      // when it sits inline in dense layouts.
      style={{ minHeight: 44 }}
      hitSlop={size === 'sm' ? 8 : 0}
      onPress={(e) => {
        if (!noHaptic) haptics.tap();
        onPress?.(e);
      }}
      className={[
        'flex-row items-center justify-center gap-2',
        SIZE[size].box,
        CONTAINER[variant],
        variant === 'ghost' ? '' : 'active:opacity-80',
        variant === 'ghost' ? 'active:opacity-60' : '',
        inactive ? 'opacity-40' : '',
        fullWidth ? 'w-full' : 'self-start',
        className,
      ].join(' ')}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator size="small" color={iconColor ?? '#2563EB'} />
      ) : (
        <>
          {icon ? (
            // Decorative: the label already carries the meaning, so announcing the
            // glyph name would just make the button read twice.
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Ionicons name={icon} size={18} color={iconColor} />
            </View>
          ) : null}
          <Text variant={SIZE[size].text} tone={LABEL_TONE[variant]} className="font-semibold">
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Icon-only affordance (close, back, share). Requires a label — it has no visible text. */
export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  size = 22,
  className = '',
  tone = 'default',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  accessibilityLabel: string;
  onPress?: () => void;
  size?: number;
  className?: string;
  tone?: 'default' | 'onImage';
}) {
  // Icons take a `color` prop, not className — @expo/vector-icons is not registered with
  // NativeWind's cssInterop, so a className here would be silently dropped.
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        haptics.tap();
        onPress?.();
      }}
      style={{ minHeight: 44, minWidth: 44 }}
      className={[
        'items-center justify-center rounded-full active:opacity-60',
        tone === 'onImage' ? 'bg-black/40' : '',
        className,
      ].join(' ')}
    >
      {/* onImage sits over artwork of unknown brightness, so it forces white rather
          than following the theme. */}
      <Ionicons name={icon} size={size} color={tone === 'onImage' ? '#FFFFFF' : colors.text} />
    </Pressable>
  );
}
