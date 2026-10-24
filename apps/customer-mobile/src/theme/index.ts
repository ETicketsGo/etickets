import { useColorScheme } from 'react-native';
import { radius, typeScale } from '@eticketsgo/design-tokens';

/**
 * Imperative theme for non-className styling (StatusBar, ActivityIndicator, gradients).
 * Values mirror the storefront palette in packages/design-tokens/src/brand.css; className-based
 * styling uses the NativeWind tokens directly. Scales are reused from design-tokens.
 */
const light = {
  canvas: '#F6F2EA',
  surface: '#FFFFFF',
  text: '#16130F',
  textMuted: '#6A6359',
  primary: '#16130F',
  border: '#DDD5C7',
};

const dark = {
  canvas: '#16130F',
  surface: '#221E19',
  text: '#F6F2EA',
  textMuted: '#ADA497',
  primary: '#E3CFA5',
  border: '#3A342C',
};

export type ThemePalette = typeof light;

export function useTheme(): { scheme: 'light' | 'dark'; colors: ThemePalette } {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { scheme, colors: scheme === 'dark' ? dark : light };
}

export { radius, typeScale };
