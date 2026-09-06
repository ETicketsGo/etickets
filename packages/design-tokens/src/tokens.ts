/**
 * Semantic design tokens for ETicketsGo.
 *
 * Values are HSL channel triplets ("H S% L%") so they can be composed with
 * Tailwind's alpha syntax, e.g. hsl(var(--background-canvas) / 0.5).
 * Consumers reference the CSS variables (see tokens.css). This file is the
 * canonical definition and is used to generate the Tailwind color map.
 */

export const semanticColors = {
  background: {
    canvas: '--background-canvas',
    surface: '--background-surface',
    subtle: '--background-subtle',
  },
  text: {
    primary: '--text-primary',
    secondary: '--text-secondary',
    muted: '--text-muted',
  },
  border: {
    default: '--border-default',
  },
  action: {
    primary: '--action-primary',
    'primary-foreground': '--action-primary-foreground',
    secondary: '--action-secondary',
    'secondary-foreground': '--action-secondary-foreground',
    danger: '--action-danger',
    'danger-foreground': '--action-danger-foreground',
  },
  status: {
    success: '--status-success',
    warning: '--status-warning',
    error: '--status-error',
    info: '--status-info',
  },
} as const;

export const spacing = {
  base: 4,
  scale: [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32],
} as const;

/** Radius scale (rem). Buttons/inputs 14px, cards 20px, dialogs 24px, pills full. */
export const radius = {
  sm: '0.5rem',
  md: '0.875rem',
  lg: '1.25rem',
  xl: '1.5rem',
  full: '9999px',
} as const;

/** Type scale — Inter. Large, comfortable, never tiny. */
type FontSizeValue = [string, { lineHeight?: string; letterSpacing?: string; fontWeight?: string }];
export const typeScale: Record<string, FontSizeValue> = {
  hero: ['3rem', { lineHeight: '1.05', letterSpacing: '-0.02em', fontWeight: '700' }],
  h1: ['2.5rem', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '700' }],
  h2: ['2rem', { lineHeight: '1.15', letterSpacing: '-0.015em', fontWeight: '650' }],
  h3: ['1.5rem', { lineHeight: '1.25', letterSpacing: '-0.01em', fontWeight: '600' }],
  title: ['1.25rem', { lineHeight: '1.35', letterSpacing: '-0.005em', fontWeight: '600' }],
  body: ['1rem', { lineHeight: '1.6' }],
  caption: ['0.8125rem', { lineHeight: '1.45' }],
  button: ['0.9375rem', { lineHeight: '1', letterSpacing: '0.005em', fontWeight: '600' }],
};

export const breakpoints = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const;

export const fontFamily = {
  sans: [
    'Inter',
    'system-ui',
    '-apple-system',
    'Segoe UI',
    'Roboto',
    'Helvetica Neue',
    'Arial',
    'sans-serif',
  ],
} as const;

/**
 * Accent palettes an organizer can choose for their workspace.
 *
 * The key is written to `[data-accent]` on the document element and matched by `themes.css`.
 * `null` is the platform blue defined in `tokens.css` — an organization that has chosen
 * nothing carries no attribute, so nothing about its rendering changes.
 *
 * A theme changes the ACCENT FAMILY only: the primary action colour, its hover, the tint
 * behind pills, the focus ring and the informational pair. Surfaces, body text and the
 * success/warning/error semantics are fixed in every theme, which is what keeps the number
 * of colour pairs to verify finite — and every one of them is verified, per theme, by
 * `token-contrast.test.ts`.
 */
export const ACCENT_THEMES = [
  { key: 'default', label: 'ETicketsGo blue', swatch: '#1A5CEA' },
  { key: 'violet', label: 'Violet', swatch: '#7A4EE0' },
  { key: 'emerald', label: 'Emerald', swatch: '#127A5C' },
  { key: 'amber', label: 'Amber', swatch: '#A35B0A' },
  { key: 'rose', label: 'Rose', swatch: '#CF2352' },
  { key: 'slate', label: 'Slate', swatch: '#5A6B84' },
] as const;

export type AccentTheme = (typeof ACCENT_THEMES)[number]['key'];

/** Whether a stored value still names a palette this build ships. */
export function isAccentTheme(value: string | null | undefined): value is AccentTheme {
  return !!value && ACCENT_THEMES.some((t) => t.key === value);
}
