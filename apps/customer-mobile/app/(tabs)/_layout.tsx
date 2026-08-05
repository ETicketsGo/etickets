import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { useTheme } from '@/theme';
import { haptics } from '@/ui';

/**
 * The app's primary navigation: four destinations, flat, always reachable.
 *
 * Four rather than five: a tab per top-level noun the customer thinks in — browse,
 * search, what I've bought, me. Anything else (help, settings, payment methods) is a
 * row inside Profile, because a tab bar is a promise that each item is somewhere you
 * return to often, and a fifth rarely-used tab makes the other four smaller targets.
 */
export default function TabsLayout() {
  const { colors } = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          // Hairline, not the platform default 1px — matches the separators elsewhere.
          borderTopWidth: Platform.OS === 'ios' ? 0.33 : 0.5,
        },
        tabBarLabelStyle: { fontFamily: 'Inter', fontSize: 11 },
        // Long market names would otherwise truncate mid-word at large text sizes.
        tabBarAllowFontScaling: true,
      }}
      screenListeners={{ tabPress: () => haptics.tap() }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarAccessibilityLabel: 'Home',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'home' : 'home-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Search',
          tabBarAccessibilityLabel: 'Search events',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'search' : 'search-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="tickets"
        options={{
          title: 'Tickets',
          tabBarAccessibilityLabel: 'My tickets',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'ticket' : 'ticket-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarAccessibilityLabel: 'Profile and settings',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'person' : 'person-outline'} size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
