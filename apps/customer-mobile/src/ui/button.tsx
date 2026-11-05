import { ActivityIndicator, Pressable, View, type PressableProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { palette, stage } from '@/theme';
import { Text, type TextTone } from './text';
import { haptics } from './haptics';

/**
 * The storefront's buttons (DESIGN-SYSTEM.md section 4, web-kit `BrandButton`).
 *
 *  primary    ink on paper. The one main action of a view.
 *  gold       the single "Book tickets" moment, and the main action on a stage band.
 *  secondary  a hairline outline. Everything that is not the main action.
 *  quiet      text only, underlined like the website's links.
 *  danger     a destructive confirmation (delete account).
 *
 * `ghost` is the old name for `quiet`. Sentence case, a verb: "Book tickets", "Pay Rs 417".
 */
export type ButtonVariant = 'primary' | 'gold' | 'secondary' | 'quiet' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const CONTAINER: Record<ButtonVariant, string> = {
  primary: 'bg-ink active:bg-ink-hover',
  gold: 'bg-gold-on-ink active:bg-gold-hover',
  secondary: 'border border-border-strong bg-background-surface active:bg-sunken',
  quiet: 'bg-transparent active:opacity-60',
  ghost: 'bg-transparent active:opacity-60',
  danger: 'bg-critical active:opacity-80',
};

const LABEL: Record<ButtonVariant, TextTone> = {
  primary: 'onAccent',
  gold: 'primary',
  secondary: 'primary',
  quiet: 'primary',
  ghost: 'primary',
  danger: 'onAccent',
};

const SPINNER: Record<ButtonVariant, string> = {
  primary: palette.onPrimary,
  gold: stage.onAction,
  secondary: palette.text,
  quiet: palette.text,
  ghost: palette.text,
  danger: '#FFFFFF',
};

/**
 * Heights from the design system: sm 36 (dense rows only, padded out to a 44 target by
 * hitSlop), md 44 (the default touch target), lg 48 (a sticky booking bar).
 */
const SIZE: Record<ButtonSize, { box: string; height: number }> = {
  sm: { box: 'px-3.5', height: 36 },
  md: { box: 'px-5', height: 44 },
  lg: { box: 'px-6', height: 48 },
};

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Stretch to the container's width: the default for a primary call to action. */
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
  const quiet = variant === 'quiet' || variant === 'ghost';
  const iconColor =
    variant === 'primary' || variant === 'danger' ? palette.onPrimary : palette.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      // `busy` makes a screen reader announce the wait instead of silently ignoring taps.
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      style={{ minHeight: size === 'sm' ? 36 : SIZE[size].height }}
      hitSlop={size === 'sm' ? 4 : 0}
      onPress={(e) => {
        if (!noHaptic) haptics.tap();
        onPress?.(e);
      }}
      className={[
        'flex-row items-center justify-center gap-2 rounded-control',
        quiet ? 'px-1' : SIZE[size].box,
        CONTAINER[variant],
        inactive ? 'opacity-40' : '',
        fullWidth ? 'w-full' : 'self-start',
        className,
      ].join(' ')}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator size="small" color={SPINNER[variant]} />
      ) : (
        <>
          {icon ? (
            // Decorative: the label carries the meaning, so the glyph is not announced.
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Ionicons name={icon} size={18} color={iconColor} />
            </View>
          ) : null}
          <Text
            variant={size === 'lg' ? 'body' : 'ui'}
            tone={LABEL[variant]}
            className={`font-semibold ${quiet ? 'underline' : ''}`}
            numberOfLines={1}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Icon-only affordance (close, back, share). Requires a label: it has no visible text. */
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
  /** `onImage` and `onStage` sit on dark backgrounds; `outlined` is the website's round pill. */
  tone?: 'default' | 'onImage' | 'onStage' | 'outlined';
}) {
  // Icons take a `color` prop, not className: @expo/vector-icons is not registered with
  // NativeWind's cssInterop, so a className colour would be silently dropped.
  const color = tone === 'onImage' ? '#FFFFFF' : tone === 'onStage' ? stage.text : palette.text;
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
        tone === 'onImage' ? 'bg-black/45' : '',
        tone === 'outlined' ? 'border border-border-strong bg-background-surface' : '',
        className,
      ].join(' ')}
    >
      <Ionicons name={icon} size={size} color={color} />
    </Pressable>
  );
}
