import type { Config } from 'tailwindcss';
import { fontFamily, radius, typeScale } from './tokens';

/** Wraps a CSS variable so Tailwind can apply alpha via <alpha-value>. */
const hsl = (v: string) => `hsl(var(${v}) / <alpha-value>)`;

/**
 * Shared Tailwind preset consumed by every frontend app. Colors, radii, shadows
 * and type scale all map to the semantic tokens in tokens.css so the three apps
 * render as one premium product.
 */
const preset: Partial<Config> = {
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', ...fontFamily.sans],
        /*
          Page titles and big numbers only. The consoles load Plus Jakarta Sans into
          --font-display; anywhere that does not, this falls back to the UI face rather than
          to a browser default.
        */
        display: ['var(--font-display)', 'var(--font-inter)', ...fontFamily.sans],
      },
      maxWidth: {
        /*
          ── THE PAGE SHELL ────────────────────────────────────────────────────────────
          One width, named once, so the header, the content and the footer cannot disagree
          about where the page edge is. They did: content and header sat at 72rem while the
          marketing footer sat at 80rem, and the footer's edges visibly missed the columns
          above them.

          90rem (1440px) rather than the old 72rem (1152px). At 1152 a card grid on a
          1920-wide display left 384px of empty gutter on each side — enough that the page
          read as though something had failed to load rather than as a deliberate margin.
          1440 keeps a comfortable margin at 1920 and changes nothing below 1440, which is
          most laptops.

          This is the shell, NOT a reading width. Prose still constrains itself further —
          65 characters is a line length, and it does not get longer because a monitor did.
        */
        shell: '90rem',
        /** Long-form reading: articles, policies, a paragraph of explanation. */
        prose: '42rem',
        /** A console form's main column (DESIGN-DIRECTION: 640-720px). */
        form: '45rem',
      },
      fontSize: {
        hero: typeScale.hero,
        h1: typeScale.h1,
        h2: typeScale.h2,
        h3: typeScale.h3,
        title: typeScale.title,
        body: typeScale.body,
        caption: typeScale.caption,
        button: typeScale.button,
        // The console scale (30 / 24 / 14 / 12) - see tokens.ts.
        display: typeScale.display,
        headline: typeScale.headline,
        ui: typeScale.ui,
        micro: typeScale.micro,
      },
      spacing: {
        /*
          The console frame, named once so the sidebar, the rail, the top bar and anything
          that has to line up with them agree. The page gutter is 24px (`6`) on a desktop.
        */
        'shell-sidebar': '17rem',
        'shell-rail': '4.5rem',
        'shell-topbar': '4rem',
      },
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
          /*
            The boundary of a form control, which WCAG 1.4.11 requires to be visible at 3:1.
            `border-DEFAULT` is decoration and is deliberately far fainter — use this one on
            anything a person is meant to click or type into.
          */
          input: hsl('--border-input'),
        },
        action: {
          primary: hsl('--action-primary'),
          'primary-hover': hsl('--action-primary-hover'),
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
        /*
          Solid backgrounds for the badge/pill/eyebrow family — `bg-tint-warning`, never
          `bg-status-warning/15`. A wash takes its contrast from whatever is behind it, so
          the same badge passed AA on a card and failed on a tinted section. See tokens.css.
        */
        tint: {
          primary: hsl('--tint-primary'),
          success: hsl('--tint-success'),
          warning: hsl('--tint-warning'),
          error: hsl('--tint-error'),
          info: hsl('--tint-info'),
          marquee: hsl('--tint-marquee'),
        },
        /*
          The warm second accent: today, on sale now, live check-in. Text and icons use
          `marquee`; `marquee-fill` is a decorative stripe next to the words. Never a warning.
        */
        marquee: {
          DEFAULT: hsl('--marquee'),
          fill: hsl('--marquee-fill'),
        },
        /*
          The console sidebar's own palette: `bg-nav`, `text-nav-foreground`, `text-nav-muted`
          for group headings, `bg-nav-active` + `text-nav-active-foreground` for the current
          page, `bg-nav-accent` for its bar. Only ever on the navy - see tokens.css.
        */
        nav: {
          DEFAULT: hsl('--nav-background'),
          foreground: hsl('--nav-foreground'),
          muted: hsl('--nav-muted'),
          hover: hsl('--nav-hover'),
          active: hsl('--nav-active'),
          'active-foreground': hsl('--nav-active-foreground'),
          accent: hsl('--nav-accent'),
          border: hsl('--nav-border'),
        },
        /*
          Pastel icon tiles: `bg-tile-blue text-tile-blue-foreground`. For the icon of a stat
          card or a quick action, never for body text.
        */
        tile: {
          blue: hsl('--tile-blue'),
          'blue-foreground': hsl('--tile-blue-foreground'),
          purple: hsl('--tile-purple'),
          'purple-foreground': hsl('--tile-purple-foreground'),
          amber: hsl('--tile-amber'),
          'amber-foreground': hsl('--tile-amber-foreground'),
          teal: hsl('--tile-teal'),
          'teal-foreground': hsl('--tile-teal-foreground'),
          rose: hsl('--tile-rose'),
          'rose-foreground': hsl('--tile-rose-foreground'),
        },
        ring: hsl('--ring'),
      },
      borderRadius: {
        sm: radius.sm,
        DEFAULT: radius.md,
        md: radius.md,
        lg: radius.lg,
        xl: radius.lg,
        '2xl': radius.xl,
        full: radius.full,
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        none: 'none',
      },
      ringColor: {
        DEFAULT: hsl('--ring'),
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out',
        'fade-up': 'fade-up 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scale-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
      transitionTimingFunction: {
        premium: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
};

export default preset;
