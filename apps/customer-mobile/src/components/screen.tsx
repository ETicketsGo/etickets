import { type ReactNode } from 'react';
import { View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

/**
 * Standard screen shell: safe-area aware, on the ivory paper, dark status-bar icons.
 * `tone="stage"` is a full-screen stage (the ticket pass, the seat map) with light icons.
 */
export function Screen({
  children,
  edges = ['top', 'bottom'],
  padded = true,
  tone = 'paper',
}: {
  children: ReactNode;
  edges?: Edge[];
  padded?: boolean;
  tone?: 'paper' | 'stage';
}) {
  return (
    <SafeAreaView
      edges={edges}
      className={`flex-1 ${tone === 'stage' ? 'bg-stage' : 'bg-background-canvas'}`}
    >
      <StatusBar style={tone === 'stage' ? 'light' : 'dark'} />
      <View className={`flex-1 ${padded ? 'px-4' : ''}`}>{children}</View>
    </SafeAreaView>
  );
}
