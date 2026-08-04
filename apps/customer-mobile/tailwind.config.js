/**
 * NativeWind theme. Reuses the ETicketsGo design-tokens scales (radius/spacing/
 * type) as the single source of truth; colors map to CSS variables defined in
 * `global.css` (mirrored from packages/design-tokens/src/tokens.css) so light/dark
 * follow the device automatically.
 */
const tokens = require('@eticketsgo/design-tokens');

const hsl = (v) => `hsl(var(${v}) / <alpha-value>)`;

module.exports = {
  darkMode: 'media',
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        background: {
          canvas: hsl('--background-canvas'),
          surface: hsl('--background-surface'),
          subtle: hsl('--background-subtle'),
          elevated: hsl('--background-elevated'),
        },
        text: {
          primary: hsl('--text-primary'),
          secondary: hsl('--text-secondary'),
          muted: hsl('--text-muted'),
        },
        border: {
          DEFAULT: hsl('--border-default'),
          strong: hsl('--border-strong'),
        },
        action: {
          primary: hsl('--action-primary'),
          'primary-foreground': hsl('--action-primary-foreground'),
          secondary: hsl('--action-secondary'),
          'secondary-foreground': hsl('--action-secondary-foreground'),
          danger: hsl('--action-danger'),
          'danger-foreground': hsl('--action-danger-foreground'),
        },
        status: {
          success: hsl('--status-success'),
          warning: hsl('--status-warning'),
          error: hsl('--status-error'),
          info: hsl('--status-info'),
        },
        ring: hsl('--ring'),
      },
      borderRadius: {
        sm: tokens.radius?.sm ?? '8px',
        md: tokens.radius?.md ?? '14px',
        lg: tokens.radius?.lg ?? '20px',
        xl: tokens.radius?.xl ?? '24px',
      },
      fontFamily: {
        sans: ['Inter', 'System'],
      },
    },
  },
  plugins: [],
};
