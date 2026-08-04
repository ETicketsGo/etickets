import { View } from 'react-native';
import { useTheme } from '@/theme';
import { Text } from '@/ui';
import { formatMoney } from '@/services/locale';
import { seatStyle } from './seat-colors';
import type { SeatCategory, SeatVisualState } from './schema';

/**
 * Legend for seat states and price zones.
 *
 * Not optional decoration: nothing else on the screen explains that amber means someone
 * else is midway through buying that seat, and a user who does not know that reads it as
 * a fault.
 */
export function SeatLegend({
  categories,
  currency,
}: {
  categories: SeatCategory[];
  currency: string;
}) {
  const { scheme } = useTheme();

  const states: { state: SeatVisualState; label: string }[] = [
    { state: 'available', label: 'Available' },
    { state: 'selected', label: 'Selected' },
    { state: 'held', label: 'On hold' },
    { state: 'sold', label: 'Sold' },
  ];

  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap gap-x-4 gap-y-2" accessibilityLabel="Seat state legend">
        {states.map(({ state, label }) => {
          const style = seatStyle(state, scheme);
          return (
            <View key={state} className="flex-row items-center gap-1.5">
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  backgroundColor: style.fill,
                  borderColor: style.border,
                  borderWidth: 1,
                  opacity: style.opacity,
                }}
              />
              <Text variant="caption" tone="muted">
                {label}
              </Text>
            </View>
          );
        })}
      </View>

      {categories.length > 0 ? (
        <View className="flex-row flex-wrap gap-x-4 gap-y-2" accessibilityLabel="Price zones">
          {categories.map((c) => (
            <View key={c.id} className="flex-row items-center gap-1.5">
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  // The server supplies a zone colour; fall back to a neutral dot rather
                  // than inventing one, so a missing colour is visibly missing.
                  backgroundColor: c.colorHex ?? '#94A3B8',
                }}
              />
              <Text variant="caption" tone="muted">
                {c.name} · {formatMoney(c.priceMinor, currency)}
                {c.ticketTypeId ? '' : ' (not on sale)'}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
