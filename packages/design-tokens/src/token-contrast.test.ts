import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every colour pair the design system claims is legible, checked as arithmetic.
 *
 * ── WHY THIS EXISTS RATHER THAN JUST AN AXE SCAN ───────────────────────────────────
 * A browser scan only ever measures the pairs that happen to be rendered on the pages it
 * happens to visit. The contrast history in `tokens.css` is three rounds of exactly that:
 * a scan found `--text-muted` failing on one screen and it was darkened; a later scan found
 * `--action-primary` failing on a nav item and it was darkened; a site-wide scan then found
 * four status colours failing on nineteen storefront pages at once. Each round fixed the
 * instance that was looked at.
 *
 * These ratios are a property of the numbers in `tokens.css`, not of any page, so they can
 * be checked exhaustively and instantly. The scan still runs — it catches what this cannot,
 * which is a component using a pair nobody declared. This catches what the scan cannot,
 * which is a pair that is wrong before anyone renders it.
 *
 * ── AND WHY THE TINTS ARE OPAQUE ───────────────────────────────────────────────────
 * The badge family used to paint its foreground over an alpha wash of itself. The contrast
 * of a wash depends on what is behind it, so there is no single number to assert and no way
 * to be right at the point the colour is defined — the same badge measured 4.50:1 on a white
 * card and 4.12:1 on a tinted section. Opaque tints make each pair a fixed number, which is
 * what makes this file possible at all.
 *
 * Read from the CSS itself. A copy of the values here would be a test of the copy.
 */
const CSS = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');

/** The console scope's selectors, exactly as tokens.css writes them. See the console block. */
const CONSOLE_LIGHT = ':root[data-console]:not([data-accent]) {';
const CONSOLE_DARK = ':root.dark[data-console]:not([data-accent]) {';

/** WCAG 2.1 AA for normal-size text. Large text is 3:1; nothing here relies on that. */
const AA_NORMAL = 4.5;
/** WCAG 2.1 SC 1.4.11 — a control has to be distinguishable from what surrounds it. */
const AA_NON_TEXT = 3;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `--text-muted: 220 9% 44%;` → {h,s,l}, from the block for one theme. */
function readToken(block: string, name: string): Rgb {
  const m = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(block);
  if (!m) throw new Error(`token --${name} not found`);
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lig - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The light and dark blocks, separately.
 *
 * Split on `.dark {` rather than parsed as CSS: the two themes redefine the SAME variable
 * names, so a whole-file regex silently returns whichever came first and would test light
 * mode twice while reporting that dark mode passes.
 */
function themeBlocks(): { light: string; dark: string } {
  const i = CSS.indexOf('.dark {');
  expect(i, 'tokens.css has no .dark block').toBeGreaterThan(0);
  /*
    The dark block ends where the console scope begins. Those blocks redefine the accent
    family too, and a dark slice that ran to the end of the file would contain both.
  */
  const end = CSS.indexOf(CONSOLE_LIGHT);
  return { light: CSS.slice(0, i), dark: CSS.slice(i, end > i ? end : undefined) };
}

/** Every pair a component is allowed to render, as foreground-on-background. */
const PAIRS: { fg: string; bg: string; what: string }[] = [
  // Body and supporting text, on each surface it is used on.
  { fg: 'text-primary', bg: 'background-canvas', what: 'body text on the page' },
  { fg: 'text-primary', bg: 'background-surface', what: 'body text on a card' },
  { fg: 'text-primary', bg: 'background-subtle', what: 'body text on a subtle panel' },
  { fg: 'text-secondary', bg: 'background-canvas', what: 'secondary text on the page' },
  { fg: 'text-secondary', bg: 'background-surface', what: 'secondary text on a card' },
  { fg: 'text-secondary', bg: 'background-subtle', what: 'secondary text on a panel' },
  { fg: 'text-muted', bg: 'background-canvas', what: 'captions on the page' },
  { fg: 'text-muted', bg: 'background-surface', what: 'captions on a card' },
  { fg: 'text-muted', bg: 'background-subtle', what: 'captions on a panel' },

  // Solid buttons.
  { fg: 'action-primary-foreground', bg: 'action-primary', what: 'the primary button' },
  { fg: 'action-primary-foreground', bg: 'action-primary-hover', what: 'primary button, hover' },
  { fg: 'action-secondary-foreground', bg: 'action-secondary', what: 'the secondary button' },
  { fg: 'action-danger-foreground', bg: 'action-danger', what: 'the danger button' },

  // The badge/pill/eyebrow family — the pairs that kept regressing.
  { fg: 'action-primary', bg: 'tint-primary', what: 'an eyebrow or primary pill' },
  { fg: 'status-success', bg: 'tint-success', what: 'a success badge' },
  { fg: 'status-warning', bg: 'tint-warning', what: 'a warning badge' },
  { fg: 'status-error', bg: 'tint-error', what: 'an error badge' },
  { fg: 'status-info', bg: 'tint-info', what: 'an info badge' },

  // Status text on plain surfaces — "Sold out", inline error messages.
  { fg: 'status-error', bg: 'background-surface', what: 'an inline error message' },
  { fg: 'status-success', bg: 'background-surface', what: 'inline success text' },
  { fg: 'status-warning', bg: 'background-surface', what: 'inline warning text' },
];

describe.each(['light', 'dark'] as const)('%s mode clears WCAG AA', (theme) => {
  const block = themeBlocks()[theme];

  it.each(PAIRS)('$what — $fg on $bg', ({ fg, bg }) => {
    const ratio = contrast(readToken(block, fg), readToken(block, bg));
    /*
      Reported to two decimals in the failure message, because "expected 4.5, got 4.4718"
      tells whoever broke it how far off they are and therefore whether to nudge the colour
      or rethink it.
    */
    expect(
      Number(ratio.toFixed(2)),
      `--${fg} on --${bg} is ${ratio.toFixed(2)}:1, below the ${AA_NORMAL}:1 WCAG AA minimum for normal text`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

/**
 * Solid controls against the page behind them (SC 1.4.11 Non-text Contrast).
 *
 * Here because fixing the pair above is what breaks this one. The dark danger button failed
 * white-on-danger at 4.05:1; darkening it far enough to fix that would have taken it below
 * 3:1 against the canvas, at which point the button stops reading as a button — a fix that
 * trades a WCAG failure for a different WCAG failure. Both ends are asserted so the next
 * person adjusting either colour is told which way they have run out of room.
 */
const CONTROL_PAIRS: { control: string; behind: string; what: string }[] = [
  { control: 'action-primary', behind: 'background-canvas', what: 'a primary button on the page' },
  { control: 'action-primary', behind: 'background-surface', what: 'a primary button on a card' },
  { control: 'action-danger', behind: 'background-canvas', what: 'a danger button on the page' },
  { control: 'action-danger', behind: 'background-surface', what: 'a danger button on a card' },
  /*
    `border-input`, not `border-default` or `border-strong`. Those two are decoration — card
    edges and table rules — which 1.4.11 exempts and which are deliberately faint. A field's
    outline is the only thing identifying it as a field, so it is held to the 3:1 line, on
    every surface a field is actually placed on.
  */
  { control: 'border-input', behind: 'background-surface', what: 'a field outline on a card' },
  { control: 'border-input', behind: 'background-canvas', what: 'a field outline on the page' },
  { control: 'border-input', behind: 'background-subtle', what: 'a field outline on a panel' },
  { control: 'ring', behind: 'background-canvas', what: 'the focus ring' },
];

describe.each(['light', 'dark'] as const)('%s mode: controls stay visible', (theme) => {
  const block = themeBlocks()[theme];

  it.each(CONTROL_PAIRS)('$what — $control against $behind', ({ control, behind }) => {
    const ratio = contrast(readToken(block, control), readToken(block, behind));
    expect(
      Number(ratio.toFixed(2)),
      `--${control} against --${behind} is ${ratio.toFixed(2)}:1, below the ${AA_NON_TEXT}:1 WCAG AA minimum for a control boundary`,
    ).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

/**
 * Every selectable accent palette, held to exactly the same arithmetic.
 *
 * ── WHY THIS IS THE PART THAT MATTERS ──────────────────────────────────────────────
 * Offering themes is offering to let somebody change colours nobody checked. Done casually
 * it is a machine for producing accessibility regressions: the workspace that picks amber
 * gets an unreadable primary button, and it is unreadable only for that organization, on
 * their screen, where no scan of ours will ever look at it.
 *
 * A theme overrides only the accent family, so the pairs it can break are a short, known
 * list — and they are checked here from the same file the browser loads. A palette whose
 * numbers do not work fails the build.
 *
 * The default blue is absent on purpose: it is `tokens.css`, already covered above, and an
 * organization that has chosen nothing carries no attribute at all.
 */
const THEMES_CSS = readFileSync(resolve(__dirname, 'themes.css'), 'utf8');

/** Accent-family pairs. Everything else in a themed page comes from `tokens.css`. */
const ACCENT_PAIRS: { fg: string; bg: string; what: string }[] = [
  { fg: 'action-primary-foreground', bg: 'action-primary', what: 'the primary button' },
  { fg: 'action-primary-foreground', bg: 'action-primary-hover', what: 'primary button, hover' },
  { fg: 'action-primary', bg: 'tint-primary', what: 'an eyebrow or primary pill' },
  { fg: 'status-info', bg: 'tint-info', what: 'an info badge' },
];

/**
 * The accent against the page behind it (SC 1.4.11) — read from `tokens.css`, because a
 * theme does not redefine the surfaces and must be judged against the real ones.
 */
const ACCENT_CONTROLS: { behind: string; what: string }[] = [
  { behind: 'background-canvas', what: 'a primary button on the page' },
  { behind: 'background-surface', what: 'a primary button on a card' },
];

/**
 * One theme's block, found by its exact selector rather than by a pattern.
 *
 * Deliberately not a regex. The light selector is a suffix of the dark one, so a pattern for
 * `[data-accent='violet']` also matches inside `.dark[data-accent='violet']` — which would
 * have every light-mode assertion silently measuring the dark palette and passing. Matching
 * the whole line removes the ambiguity instead of trying to express it in escapes.
 */
function accentBlock(theme: string, mode: 'light' | 'dark'): string {
  const selector = mode === 'dark' ? `.dark[data-accent='${theme}']` : `[data-accent='${theme}']`;
  const marker = `
${selector} {`;
  const at = THEMES_CSS.indexOf(marker);
  expect(at, `themes.css has no ${mode} block for '${theme}'`).toBeGreaterThanOrEqual(0);
  const from = at + marker.length;
  const to = THEMES_CSS.indexOf('}', from);
  return THEMES_CSS.slice(from, to);
}

/** Read from the file rather than imported, so a palette cannot be shipped unlisted. */
const THEME_KEYS = [...THEMES_CSS.matchAll(/\[data-accent='([a-z]+)'\]/g)]
  .map((m) => m[1])
  .filter((v, i, a) => a.indexOf(v) === i);

describe('every accent palette is a real palette', () => {
  it('themes.css defines at least one', () => {
    expect(THEME_KEYS.length).toBeGreaterThan(0);
  });
});

describe.each(THEME_KEYS)("accent '%s' clears WCAG AA", (theme) => {
  describe.each(['light', 'dark'] as const)('%s mode', (mode) => {
    const block = accentBlock(theme, mode);
    const surfaces = themeBlocks()[mode];

    it.each(ACCENT_PAIRS)('$what — $fg on $bg', ({ fg, bg }) => {
      const ratio = contrast(readToken(block, fg), readToken(block, bg));
      expect(
        Number(ratio.toFixed(2)),
        `'${theme}' ${mode}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, below ${AA_NORMAL}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it.each(ACCENT_CONTROLS)('$what', ({ behind }) => {
      const ratio = contrast(readToken(block, 'action-primary'), readToken(surfaces, behind));
      expect(
        Number(ratio.toFixed(2)),
        `'${theme}' ${mode}: --action-primary against --${behind} is ${ratio.toFixed(2)}:1, below ${AA_NON_TEXT}:1`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });

    it('the focus ring stays visible on the page', () => {
      const ratio = contrast(readToken(block, 'ring'), readToken(surfaces, 'background-canvas'));
      expect(
        Number(ratio.toFixed(2)),
        `'${theme}' ${mode}: --ring against the canvas is ${ratio.toFixed(2)}:1, below ${AA_NON_TEXT}:1`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });
  });
});

describe('the tint tokens exist in both themes', () => {
  /*
    A tint defined only in light mode inherits nothing in dark mode — the variable is simply
    unset and the background falls back to transparent, which puts dark-mode badge text on
    whatever is behind it. That renders as "almost right" and is exactly the failure the
    opaque tints were introduced to remove, so its absence is asserted rather than assumed.
  */
  const { light, dark } = themeBlocks();
  it.each(['tint-primary', 'tint-success', 'tint-warning', 'tint-error', 'tint-info'])(
    '--%s',
    (name) => {
      expect(light, `--${name} missing from :root`).toContain(`--${name}:`);
      expect(dark, `--${name} missing from .dark`).toContain(`--${name}:`);
    },
  );
});

/**
 * The console accent - organizer and admin only - held to the same pairs as a theme.
 *
 * It is the colour every organizer who has not picked a palette works in all day, so it is
 * the accent most worth checking. Its surfaces are the shared ones in `tokens.css`, because
 * the console scope changes the accent family and nothing else.
 */
function consoleBlock(mode: 'light' | 'dark'): string {
  const selector = mode === 'dark' ? CONSOLE_DARK : CONSOLE_LIGHT;
  const at = CSS.indexOf(selector);
  expect(at, `tokens.css has no ${mode} console block`).toBeGreaterThan(0);
  const from = at + selector.length;
  return CSS.slice(from, CSS.indexOf('}', from));
}

/** `--status-info` is not part of the console scope; it stays the shared blue on purpose. */
const CONSOLE_PAIRS = ACCENT_PAIRS.filter((p) => p.fg !== 'status-info');

describe.each(['light', 'dark'] as const)('console accent, %s mode, clears WCAG AA', (mode) => {
  const block = consoleBlock(mode);
  const surfaces = themeBlocks()[mode];

  it.each(CONSOLE_PAIRS)('$what - $fg on $bg', ({ fg, bg }) => {
    const ratio = contrast(readToken(block, fg), readToken(block, bg));
    expect(
      Number(ratio.toFixed(2)),
      `console ${mode}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, below ${AA_NORMAL}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  /*
    The accent is also TEXT straight on a surface - a link, the active nav label, a number in
    a stat card - so it has to clear 4.5:1 there, not just the 3:1 a control boundary needs.
  */
  it.each(['background-canvas', 'background-surface', 'background-subtle'])(
    'accent text on %s',
    (behind) => {
      const ratio = contrast(readToken(block, 'action-primary'), readToken(surfaces, behind));
      expect(
        Number(ratio.toFixed(2)),
        `console ${mode}: --action-primary on --${behind} is ${ratio.toFixed(2)}:1, below ${AA_NORMAL}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    },
  );

  it.each(['background-canvas', 'background-surface'])('the focus ring on %s', (behind) => {
    const ratio = contrast(readToken(block, 'ring'), readToken(surfaces, behind));
    expect(
      Number(ratio.toFixed(2)),
      `console ${mode}: --ring against --${behind} is ${ratio.toFixed(2)}:1, below ${AA_NON_TEXT}:1`,
    ).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it('changes the accent family only, never a token the storefront shares', () => {
    for (const shared of ['background-', 'text-', 'border-', 'status-', 'action-danger']) {
      expect(block, `console block redefines a shared --${shared}* token`).not.toContain(
        `--${shared}`,
      );
    }
  });
});

/**
 * The console's own surfaces - organizer and admin only - with every pair a page can render
 * on them: body text, the console accent, the marquee, and the controls.
 *
 * Measured against the MERGED values a console actually computes: its surfaces first, then
 * the accent block, then the shared theme for everything neither redefines (`readToken`
 * takes the first match, so order is precedence).
 */
const CONSOLE_SURFACES_LIGHT = ':root[data-console] {';
const CONSOLE_SURFACES_DARK = ':root.dark[data-console] {';

function consoleSurfaces(mode: 'light' | 'dark'): string {
  const selector = mode === 'dark' ? CONSOLE_SURFACES_DARK : CONSOLE_SURFACES_LIGHT;
  const at = CSS.indexOf(`\n${selector}`);
  expect(at, `tokens.css has no ${mode} console surfaces block`).toBeGreaterThan(0);
  const from = at + selector.length + 1;
  return CSS.slice(from, CSS.indexOf('}', from));
}

describe.each(['light', 'dark'] as const)('console surfaces, %s mode, clear WCAG AA', (mode) => {
  const merged = consoleSurfaces(mode) + consoleBlock(mode) + themeBlocks()[mode];

  it.each(PAIRS)('$what - $fg on $bg', ({ fg, bg }) => {
    const ratio = contrast(readToken(merged, fg), readToken(merged, bg));
    expect(
      Number(ratio.toFixed(2)),
      `console ${mode}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, below ${AA_NORMAL}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(CONTROL_PAIRS)('$what - $control against $behind', ({ control, behind }) => {
    const ratio = contrast(readToken(merged, control), readToken(merged, behind));
    expect(
      Number(ratio.toFixed(2)),
      `console ${mode}: --${control} against --${behind} is ${ratio.toFixed(2)}:1, below ${AA_NON_TEXT}:1`,
    ).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it.each(['background-canvas', 'background-surface', 'background-subtle', 'tint-primary'])(
    'the accent as text on %s',
    (behind) => {
      const ratio = contrast(readToken(merged, 'action-primary'), readToken(merged, behind));
      expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(AA_NORMAL);
    },
  );

  it.each(['background-canvas', 'background-surface', 'background-subtle', 'tint-marquee'])(
    'the marquee as text on %s',
    (behind) => {
      const ratio = contrast(readToken(merged, 'marquee'), readToken(merged, behind));
      expect(
        Number(ratio.toFixed(2)),
        `console ${mode}: --marquee on --${behind} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    },
  );

  /*
    `border-input` is allowed here and nowhere else in the list. It is not decoration: it is
    the 3:1 outline of a field, solved against the surfaces it sits on, so when the surfaces
    move it may have to move with them - the dark console's subtle panel took the shared
    outline to 2.81:1. CONTROL_PAIRS above holds whatever value it ends up with.
  */
  it('redefines surfaces and ink only, never the accent or a status colour', () => {
    const block = consoleSurfaces(mode);
    for (const other of ['action-', 'status-', 'tint-', 'ring', 'nav-', 'tile-']) {
      expect(block, `console surfaces redefine --${other}*`).not.toContain(`--${other}`);
    }
  });
});

/**
 * The console sidebar: light text on deep navy, in both themes.
 *
 * Its own palette, so its own pairs. The group headings are the quiet ones and the easiest to
 * let slide below AA "because they are only labels" - but a heading is what somebody scans
 * for, so they are held to 4.5:1 like the links. The teal bar and the focus ring on the navy
 * are non-text (3:1); the active pill's label is text.
 */
const NAV_PAIRS: { fg: string; bg: string; min: number; what: string }[] = [
  { fg: 'nav-foreground', bg: 'nav-background', min: AA_NORMAL, what: 'a nav link' },
  { fg: 'nav-foreground', bg: 'nav-hover', min: AA_NORMAL, what: 'a nav link, hovered' },
  { fg: 'nav-muted', bg: 'nav-background', min: AA_NORMAL, what: 'a group heading' },
  { fg: 'nav-muted', bg: 'nav-hover', min: AA_NORMAL, what: 'a group heading, hovered' },
  {
    fg: 'nav-active-foreground',
    bg: 'nav-active',
    min: AA_NORMAL,
    what: 'the current page pill',
  },
  { fg: 'nav-accent', bg: 'nav-background', min: AA_NON_TEXT, what: 'focus ring on the navy' },
  { fg: 'nav-accent', bg: 'nav-active', min: AA_NON_TEXT, what: 'the current-page bar' },
];

describe.each(['light', 'dark'] as const)('the console sidebar, %s mode', (mode) => {
  const block = themeBlocks()[mode];
  it.each(NAV_PAIRS)('$what - $fg on $bg', ({ fg, bg, min }) => {
    const ratio = contrast(readToken(block, fg), readToken(block, bg));
    expect(
      Number(ratio.toFixed(2)),
      `${mode}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, below ${min}:1`,
    ).toBeGreaterThanOrEqual(min);
  });
});

/**
 * Pastel tiles: the icon (and any short label) in each tile's own colour, on the tile.
 *
 * Held to 4.5:1 rather than the 3:1 an icon alone would need, so a page team can put a word
 * in a tile - "Create event" in a quick-action tile - without re-checking anything.
 */
const TILES = ['blue', 'purple', 'amber', 'teal', 'rose'];

describe.each(['light', 'dark'] as const)('pastel tiles, %s mode', (mode) => {
  const block = themeBlocks()[mode];
  it.each(TILES)('the %s tile', (tile) => {
    const ratio = contrast(
      readToken(block, `tile-${tile}-foreground`),
      readToken(block, `tile-${tile}`),
    );
    expect(
      Number(ratio.toFixed(2)),
      `${mode}: --tile-${tile}-foreground on --tile-${tile} is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('the console palettes exist in both themes', () => {
  /*
    The same trap as the tints: a token defined only in light mode is UNSET in dark mode, and
    `bg-nav` on an unset variable is transparent - a sidebar of light text on a light page.
  */
  const { light, dark } = themeBlocks();
  const names = [
    'nav-background',
    'nav-foreground',
    'nav-muted',
    'nav-hover',
    'nav-active',
    'nav-active-foreground',
    'nav-accent',
    'nav-border',
    ...TILES.flatMap((t) => [`tile-${t}`, `tile-${t}-foreground`]),
  ];
  it.each(names)('--%s', (name) => {
    expect(light, `--${name} missing from :root`).toContain(`--${name}:`);
    expect(dark, `--${name} missing from .dark`).toContain(`--${name}:`);
  });
});

describe.each(['light', 'dark'] as const)(
  'the marquee, %s mode, on the shared surfaces',
  (mode) => {
    const block = themeBlocks()[mode];
    it.each(['background-canvas', 'background-surface', 'background-subtle', 'tint-marquee'])(
      'as text on %s',
      (behind) => {
        const ratio = contrast(readToken(block, 'marquee'), readToken(block, behind));
        expect(
          Number(ratio.toFixed(2)),
          `${mode}: --marquee on --${behind} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      },
    );
    it('keeps the marquee hue apart from the warning hue', () => {
      // A marquee that drifts into the warning amber is a warning nobody issued.
      const hue = (name: string) => Number(new RegExp(`--${name}:\\s*([\\d.]+)`).exec(block)![1]);
      expect(Math.abs(hue('marquee') - hue('status-warning'))).toBeGreaterThanOrEqual(6);
    });
  },
);
