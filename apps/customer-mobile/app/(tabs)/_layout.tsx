import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette } from '@/theme';
import { haptics } from '@/ui';

/**
 * The storefront's phone navigation (DESIGN-SYSTEM.md section 5): four items, Home,
 * Explore, Tickets, Account; ink icons with labels; the current item marked by ink weight
 * and a gold dot. The booking flow (event, seats, checkout) is a stack ABOVE these tabs,
 * so it hides this bar and shows its own sticky booking bar instead.
 *
 * Route names stay `search` and `profile` so deep links and tests keep working; only the
 * words the customer sees changed, to match the website.
 */
type IconName = keyof typeof Ionicons.glyphMap;

function TabIcon({ name, focused }: { name: IconName; focused: boolean }) {
  return (
    <View className="items-center">
      {/* The gold dot sits above the current item, as on the website. */}
      <View
        className={`mb-0.5 h-1.5 w-1.5 rounded-full ${focused ? 'bg-gold' : 'bg-transparent'}`}
      />
      <Ionicons name={name} size={23} color={focused ? palette.text : palette.textMuted} />
    </View>
  );
}

export default function TabsLayout() {
  // 60 + the gesture-bar inset (the design system asks for at least 56 plus safe area); a fixed height would put the
  // labels under the system's own bar on a phone with gesture navigation.
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.text,
        tabBarInactiveTintColor: palette.textMuted,
        tabBarStyle: {
          backgroundColor: palette.canvas,
          borderTopColor: palette.border,
          borderTopWidth: 1,
          height: 60 + insets.bottom,
          paddingTop: 4,
          paddingBottom: insets.bottom,
        },
        tabBarItemStyle: { paddingBottom: 6 },
        tabBarLabelStyle: { fontFamily: 'Inter_500Medium', fontSize: 11 },
        tabBarAllowFontScaling: true,
      }}
      screenListeners={{ tabPress: () => haptics.tap() }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarAccessibilityLabel: 'Home',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'home' : 'home-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Explore',
          tabBarAccessibilityLabel: 'Explore events',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'compass' : 'compass-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="tickets"
        options={{
          title: 'Tickets',
          tabBarAccessibilityLabel: 'My tickets',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'ticket' : 'ticket-outline'} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Account',
          tabBarAccessibilityLabel: 'Account and settings',
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'person' : 'person-outline'} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
