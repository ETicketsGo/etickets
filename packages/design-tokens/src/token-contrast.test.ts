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
  return { light: CSS.slice(0, i), dark: CSS.slice(i) };
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
