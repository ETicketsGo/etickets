/**
 * NativeWind theme: the customer storefront's design system (docs/design/DESIGN-SYSTEM.md),
 * adapted to a phone. Colours come from packages/design-tokens/src/brand.css; the semantic
 * names map to CSS variables in global.css, and the brand names below are the same values
 * as literals for the places that need them by name (gold, the stage band).
 *
 * Light only, like the storefront. `darkMode: 'class'` with no class ever set means a phone
 * in dark mode still gets the paper page, which is what the website does too.
 */
const hsl = (v) => `hsl(var(${v}) / <alpha-value>)`;

module.exports = {
  darkMode: 'class',
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
          field: hsl('--border-field'),
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
        /*
          The brand by name (brand.css --etg-*). Gold has three jobs and three values:
          `gold` is decoration only (a dot, a rule, a selected seat) and is never text on
          paper (2.5:1); gold words on paper are `gold-text`; gold on the stage is
          `gold-on-ink`.
        */
        paper: '#F6F2EA',
        sunken: '#F0EBE1',
        ink: { DEFAULT: '#16130F', hover: '#2B2620', 2: '#3D3830', 3: '#6A6359' },
        gold: { DEFAULT: '#B8955A', text: '#84652F', 'on-ink': '#E3CFA5', hover: '#EDDFC0' },
        positive: { DEFAULT: '#2F5E45', tint: '#E6F0E9', dot: '#3F7A5A' },
        caution: { DEFAULT: '#84652F', tint: '#F8F1E4' },
        critical: { DEFAULT: '#B51D29', tint: '#FBE6E7' },
        info: { DEFAULT: '#2A4F9D', tint: '#E8EEFA' },
        /* The stage band (brand.css data-brand-tone="stage"): the lights go down. */
        stage: {
          DEFAULT: '#16130F',
          surface: '#221E19',
          sunken: '#2E2922',
          line: '#3A342C',
          'line-strong': '#4D463C',
          field: '#8A8276',
          ink: '#F6F2EA',
          'ink-2': '#CFC7BA',
          'ink-3': '#ADA497',
          positive: '#8FC1A3',
          critical: '#F4777D',
        },
        'image-fallback': '#2A221A',
      },
      borderRadius: {
        /* DESIGN-SYSTEM.md section 3: controls 10px, cards and images 16px. Nothing else. */
        control: '10px',
        card: '16px',
        sm: '8px',
        md: '10px',
        lg: '16px',
        xl: '16px',
      },
      /*
        One family per weight. Android does not synthesise weights for a custom font: with
        a single "Inter" family, `font-bold` silently renders the regular face (or the
        system font). Each face is loaded under its own name in app/_layout.tsx.
      */
      fontFamily: {
        sans: ['Inter'],
        text: ['Inter'],
        'text-medium': ['Inter_500Medium'],
        'text-semibold': ['Inter_600SemiBold'],
        'text-bold': ['Inter_700Bold'],
        'display-semibold': ['BricolageGrotesque_600SemiBold'],
        display: ['BricolageGrotesque_700Bold'],
        'display-heavy': ['BricolageGrotesque_800ExtraBold'],
      },
      /*
        The storefront's type scale (DESIGN-SYSTEM.md section 2) at its phone end. Display
        sizes take the fluid scale's 390px value; reading sizes are fixed, as on the web.
        Bricolage is tight by design, so display sizes carry a small negative tracking.
      */
      fontSize: {
        hero: ['40px', { lineHeight: '42px', letterSpacing: '-0.8px' }],
        d1: ['32px', { lineHeight: '35px', letterSpacing: '-0.6px' }],
        d2: ['24px', { lineHeight: '28px', letterSpacing: '-0.4px' }],
        d3: ['20px', { lineHeight: '24px', letterSpacing: '-0.3px' }],
        card: ['17px', { lineHeight: '22px', letterSpacing: '-0.2px' }],
        lead: ['18px', { lineHeight: '28px' }],
        body: ['16px', { lineHeight: '25px' }],
        ui: ['14px', { lineHeight: '20px' }],
        meta: ['13px', { lineHeight: '18px' }],
        eyebrow: ['12px', { lineHeight: '16px', letterSpacing: '0.96px' }],
        figure: ['28px', { lineHeight: '34px' }],
        'figure-sm': ['20px', { lineHeight: '26px' }],
        tab: ['11px', { lineHeight: '14px' }],
      },
    },
  },
  plugins: [],
};
