import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The storefront's sticky booking bar (DESIGN-SYSTEM.md section 5: the booking flow hides
 * the bottom navigation and shows this instead). Paper, a hairline, the one overlay shadow
 * the design system allows, and room for the gesture bar.
 */
export function BookingBar({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="border-t border-border bg-paper px-4 pt-3"
      style={{
        paddingBottom: Math.max(insets.bottom, 12),
        shadowColor: '#17140F',
        shadowOpacity: 0.12,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: -6 },
        elevation: 12,
      }}
    >
      {children}
    </View>
  );
}
