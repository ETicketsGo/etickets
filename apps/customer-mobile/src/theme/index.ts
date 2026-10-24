/**
 * Imperative colours for what className cannot reach: icons (@expo/vector-icons takes a
 * `color` prop), StatusBar, ActivityIndicator, the tab bar. The same values as
 * tailwind.config.js, from packages/design-tokens/src/brand.css.
 *
 * Light only, like the storefront. `useTheme` keeps its shape so callers need not change;
 * `stage` is the dark band's palette for the screens that draw one.
 */
export const palette = {
  canvas: '#F6F2EA',
  surface: '#FFFFFF',
  sunken: '#F0EBE1',
  text: '#16130F',
  textSecondary: '#3D3830',
  textMuted: '#6A6359',
  primary: '#16130F',
  onPrimary: '#F6F2EA',
  border: '#DDD5C7',
  borderStrong: '#C9BFAE',
  field: '#877F78',
  gold: '#B8955A',
  goldText: '#84652F',
  goldOnInk: '#E3CFA5',
  positive: '#2F5E45',
  critical: '#B51D29',
  imageFallback: '#2A221A',
} as const;

export const stage = {
  canvas: '#16130F',
  surface: '#221E19',
  sunken: '#2E2922',
  text: '#F6F2EA',
  textSecondary: '#CFC7BA',
  textMuted: '#ADA497',
  line: '#3A342C',
  lineStrong: '#4D463C',
  action: '#E3CFA5',
  onAction: '#16130F',
} as const;

export type ThemePalette = typeof palette;

export function useTheme(): { scheme: 'light'; colors: ThemePalette } {
  return { scheme: 'light', colors: palette };
}
