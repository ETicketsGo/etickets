import { type ReactNode } from 'react';
import { View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

/**
 * Standard screen shell: safe-area aware, theme-driven background, correct status-bar
 * style for light/dark. Every screen renders inside this for consistent, responsive
 * layout across devices/notches.
 */
export function Screen({
  children,
  edges = ['top', 'bottom'],
  padded = true,
}: {
  children: ReactNode;
  edges?: Edge[];
  padded?: boolean;
}) {
  return (
    <SafeAreaView edges={edges} className="flex-1 bg-background-canvas">
      <StatusBar style="auto" />
      <View className={`flex-1 ${padded ? 'px-5' : ''}`}>{children}</View>
    </SafeAreaView>
  );
}
