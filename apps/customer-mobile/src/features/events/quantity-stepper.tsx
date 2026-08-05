import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme';
import { Text, haptics } from '@/ui';

/**
 * −/+ quantity control.
 *
 * `max` is enforced here as well as on the server. That is not redundant: the API's
 * maxPerOrder rejection arrives after the user has committed to a number and reads as
 * the app losing their choice, whereas a disabled + button says the same thing before
 * they act on it. The server check remains the one that counts.
 */
export function QuantityStepper({
  value,
  onChange,
  max,
  min = 0,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  max: number;
  min?: number;
  /** What is being counted, for the screen reader — "General admission tickets". */
  label: string;
}) {
  const { colors } = useTheme();
  const canDecrease = value > min;
  const canIncrease = value < max;

  const step = (delta: number) => {
    const next = value + delta;
    if (next < min || next > max) {
      haptics.warning();
      return;
    }
    haptics.select();
    onChange(next);
  };

  return (
    <View
      className="flex-row items-center gap-1"
      // Announced as a single adjustable control rather than three separate elements,
      // so a screen-reader user can change it with swipe up/down.
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: `${value} of maximum ${max}` }}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') step(1);
        if (e.nativeEvent.actionName === 'decrement') step(-1);
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    >
      <StepButton
        icon="remove"
        label={`Decrease ${label}`}
        enabled={canDecrease}
        onPress={() => step(-1)}
        color={colors.text}
      />
      <Text
        variant="callout"
        className="min-w-8 text-center font-semibold"
        // The parent already announces the value; repeating it here reads it twice.
        accessibilityElementsHidden
      >
        {value}
      </Text>
      <StepButton
        icon="add"
        label={`Increase ${label}`}
        enabled={canIncrease}
        onPress={() => step(1)}
        color={colors.text}
      />
    </View>
  );
}

function StepButton({
  icon,
  label,
  enabled,
  onPress,
  color,
}: {
  icon: 'add' | 'remove';
  label: string;
  enabled: boolean;
  onPress: () => void;
  color: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={{ minHeight: 44, minWidth: 44 }}
      className={`items-center justify-center rounded-full border border-border active:opacity-60 ${
        enabled ? '' : 'opacity-30'
      }`}
    >
      <Ionicons name={icon} size={18} color={color} />
    </Pressable>
  );
}
