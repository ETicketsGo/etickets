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
      /**
       * Mobile type scale, in px, following Apple's HIG names and sizes.
       *
       * Deliberately NOT design-tokens' `typeScale`: that scale is built for desktop web
       * (hero is 3rem/48px) and its rem values would be read against a 16px root, so a
       * page heading would render at 48px on a 390pt-wide phone. The web and the app
       * share colour, radius and spacing — the things that make them look like one
       * product — but type size is a per-platform decision, and Apple's is the one an
       * iOS user's eye is calibrated to.
       *
       * Sizes are unitless-px strings so NativeWind emits plain numbers; RN then scales
       * them with the OS text-size setting (see `maxFontSizeMultiplier` in ui/text.tsx).
       */
      fontSize: {
        'large-title': ['34px', { lineHeight: '41px', letterSpacing: '0.37px' }],
        title1: ['28px', { lineHeight: '34px', letterSpacing: '0.36px' }],
        title2: ['22px', { lineHeight: '28px', letterSpacing: '0.35px' }],
        title3: ['20px', { lineHeight: '25px', letterSpacing: '0.38px' }],
        headline: ['17px', { lineHeight: '22px', letterSpacing: '-0.41px' }],
        body: ['17px', { lineHeight: '22px', letterSpacing: '-0.41px' }],
        callout: ['16px', { lineHeight: '21px', letterSpacing: '-0.32px' }],
        subhead: ['15px', { lineHeight: '20px', letterSpacing: '-0.24px' }],
        footnote: ['13px', { lineHeight: '18px', letterSpacing: '-0.08px' }],
        caption: ['12px', { lineHeight: '16px' }],
        caption2: ['11px', { lineHeight: '13px', letterSpacing: '0.07px' }],
      },
    },
  },
  plugins: [],
};
