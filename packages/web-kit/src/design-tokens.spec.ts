import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import preset from '@eticketsgo/design-tokens/tailwind-preset';

/**
 * Every colour class in the design system names a colour that exists.
 *
 * ── THE BUG THIS EXISTS TO CATCH ───────────────────────────────────────────────────
 * `Toggle` was written with `peer-checked:bg-accent`, `outline-accent` and a knob coloured
 * `bg-surface`. None of those are tokens in this project — the palette is `action-primary`,
 * `background-*`, `text-*`, `status-*`, `tint-*`. Tailwind does not warn about a class it
 * cannot resolve: it generates nothing at all and the element is simply unstyled.
 *
 * So every switch on the platform rendered as a flat grey pill. The ON state was the same
 * colour as the OFF state and the knob was invisible, which made the control look dead —
 * reported from QA as "unable to select notification preferences". The click had been working
 * the whole time and saving the preference; there was nothing to see.
 *
 * That is the worst shape a styling bug can take. It throws nothing, it fails no build, no
 * type checker knows about it, and a geometry sweep — which is what the mobile review actually
 * measured — reports the element at the right size in the right place, because it IS. Only a
 * person looking at the screen can tell, and only if they know what it should look like.
 *
 * ── WHY THIS IS SCOPED TO web-kit ──────────────────────────────────────────────────
 * These are the shared components: a wrong colour here is wrong on every screen in three
 * applications at once, which is the highest leverage place to be strict. The applications
 * have their own instances of the same problem (`bg-surface-muted`, `bg-brand`,
 * `border-border-subtle` and others); they are listed in the review notes rather than fixed
 * here, because unpicking them is a change to how those screens look and that is a decision,
 * not a typo.
 */

/** Every colour name the preset defines, flattened the way Tailwind addresses them. */
function tokenNames(): Set<string> {
  const colors = (preset as { theme?: { extend?: { colors?: Record<string, unknown> } } }).theme
    ?.extend?.colors;
  const names = new Set<string>();
  const walk = (value: unknown, prefix: string): void => {
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        walk(inner, prefix ? `${prefix}-${key}` : key);
      }
      return;
    }
    // `foo-DEFAULT` is addressed as `foo`.
    names.add(prefix.replace(/-DEFAULT$/, ''));
  };
  walk(colors ?? {}, '');
  return names;
}

/**
 * The colour utilities worth checking, and only those.
 *
 * Deliberately narrow. `text-` and `border-` also carry sizes and styles, and a checker that
 * tried to cover every prefix would spend its life distinguishing `text-lg` from `text-lime`.
 * These four are unambiguous: whatever follows them is a colour or it is nothing.
 */
const COLOUR_PREFIXES = ['bg', 'outline', 'ring', 'fill'] as const;

/** Tailwind's own palette, always available whatever this project defines. */
const BUILTIN =
  /^(inherit|current|transparent|black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-|$)/;

/** Non-colour utilities that share a prefix with one. */
const NOT_A_COLOUR =
  /^(gradient|none|clip|origin|repeat|no-repeat|auto|cover|contain|fixed|local|scroll|bottom|top|left|right|center|blend|opacity|offset|inset|dashed|dotted|double|hidden|\[)/;

/**
 * The code, without its prose.
 *
 * Comments are stripped before scanning, and that is not tidiness: the comment on the very fix
 * this test protects NAMES the broken classes, so a scanner that read comments would report the
 * explanation as the defect and stay red forever. A class name in prose is not a class.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('the design system only uses colours that exist', () => {
  const tokens = tokenNames();

  it('has a palette to check against', () => {
    // A guard on the guard: if the preset ever stops exporting colours, every other assertion
    // in this file would pass vacuously and the check would be silently worthless.
    expect(tokens.size).toBeGreaterThan(10);
    expect(tokens.has('action-primary')).toBe(true);
    expect(tokens.has('background-surface')).toBe(true);
  });

  it('names no colour the preset does not define', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(__dirname)) {
      const source = codeOnly(readFileSync(file, 'utf8'));
      const pattern = new RegExp(
        `(?:^|[\\s'"\`:])(?:[a-z-]+:)*(${COLOUR_PREFIXES.join('|')})-([a-z][a-z0-9-]*)`,
        'g',
      );
      for (const match of source.matchAll(pattern)) {
        const [, prefix, name] = match;
        if (BUILTIN.test(name) || NOT_A_COLOUR.test(name)) continue;
        if (tokens.has(name)) continue;
        offenders.push(`${file.split(/[\\/]/).pop()}: ${prefix}-${name}`);
      }
    }

    /*
      Reported as a list rather than a bare assertion, because the failure a reader needs is
      "which class, in which file" — not "expected 3 to be 0". A missing colour is invisible on
      screen until somebody notices the control looks wrong, so the test has to do the noticing.
    */
    expect(
      offenders,
      `these name a colour the design tokens do not define, so Tailwind generates nothing:\n  ${offenders.join(
        '\n  ',
      )}\n\nAvailable: ${[...tokens].sort().join(', ')}`,
    ).toEqual([]);
  });
});
