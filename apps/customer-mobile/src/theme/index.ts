import { useColorScheme } from 'react-native';
import { radius, typeScale } from '@eticketsgo/design-tokens';

/**
 * Imperative theme for non-className styling (StatusBar, ActivityIndicator, gradients).
 * Values mirror packages/design-tokens/src/tokens.css (single source); className-based
 * styling uses the NativeWind tokens directly. Scales are reused from design-tokens.
 */
const light = {
  canvas: '#FAFAFB',
  surface: '#FFFFFF',
  text: '#0F172A',
  textMuted: '#838A97',
  primary: '#2563EB',
  border: '#E5E8EE',
};

const dark = {
  canvas: '#0B0E15',
  surface: '#12151D',
  text: '#F8FAFC',
  textMuted: '#8A93A3',
  primary: '#2563EB',
  border: '#2A3140',
};

export type ThemePalette = typeof light;

export function useTheme(): { scheme: 'light' | 'dark'; colors: ThemePalette } {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { scheme, colors: scheme === 'dark' ? dark : light };
}

export { radius, typeScale };
