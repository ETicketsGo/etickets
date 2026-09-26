#!/usr/bin/env node
/**
 * Every colour and type class in the product names something the design tokens define.
 *
 * ── WHY THIS IS A SCRIPT AND NOT ONLY A TEST ───────────────────────────────────────
 * `packages/web-kit/src/design-tokens.spec.ts` guards the shared components, where a wrong
 * colour is wrong on every screen in three applications. This covers the applications too,
 * which vitest in `web-kit` cannot reach, and runs in CI beside lint.
 *
 * ── WHAT IT CATCHES ────────────────────────────────────────────────────────────────
 * Tailwind emits NOTHING for a class it cannot resolve. No error, no warning, no build
 * failure, and nothing a type checker sees - the element is simply unstyled. `Toggle` was
 * written with `bg-accent`, `bg-surface` and `outline-accent`, none of which exist here, so
 * every switch on the platform was a grey pill whose ON state matched its OFF state. It was
 * reported as "unable to select notification preferences": the clicks had been saving all
 * along, there was just nothing to see.
 *
 * The same sweep found `bg-surface-muted`, `bg-brand`, `border-border-subtle`, `bg-success`,
 * `text-brand-primary`, a `border-input` that should have been `border-border-input`, and
 * `text-h5` / `text-body-sm`, which are not in the type scale at all.
 *
 *   node scripts/check-design-tokens.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const preset = createRequire(import.meta.url)(
  './../packages/design-tokens/dist/tailwind-preset',
).default;

const extend = preset.theme?.extend ?? {};

/** Colour names, flattened the way Tailwind addresses them (`foo-DEFAULT` is `foo`). */
const colours = new Set();
(function walk(value, prefix) {
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value))
      walk(inner, prefix ? `${prefix}-${key}` : key);
    return;
  }
  colours.add(prefix.replace(/-DEFAULT$/, ''));
})(extend.colors ?? {}, '');

const fontSizes = new Set(Object.keys(extend.fontSize ?? {}));

/** Tailwind's own palette, always available. */
const BUILTIN =
  /^(inherit|current|transparent|black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-|$)/;

/** Utilities that share a prefix with a colour but are not one. */
const NOT_A_COLOUR = {
  text: /^(xs|sm|base|lg|xl|[2-9]xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|opacity|anchor)$/,
  border:
    /^(solid|dashed|dotted|double|none|hidden|collapse|separate|spacing|[trblxy]|[trblxy]-.*|[0-9]+)$/,
  divide: /^([trblxy]|[trblxy]-.*|[0-9]+|solid|dashed|dotted|double|none)$/,
  outline: /^(none|dashed|dotted|double|hidden|offset-.*|[0-9]+)$/,
  ring: /^(offset-.*|inset|[0-9]+)$/,
  bg: /^(gradient-.*|none|clip-.*|origin-.*|repeat.*|auto|cover|contain|fixed|local|scroll|blend-.*|opacity-.*|bottom|top|left|right|center)$/,
  fill: /^(none|current)$/,
};

const PATTERN =
  /(?:^|[\s'"`:{])(?:[a-z-]+:)*(bg|text|border|outline|ring|fill|divide)-([a-z][a-z0-9-]*(?:\/\d+)?)/g;

/** Comments are stripped: a class name in prose is not a class, and the comment explaining
    this very check names the broken ones. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return ['node_modules', '.next', 'dist', '.turbo'].includes(entry.name)
        ? []
        : sourceFiles(join(dir, entry.name));
    }
    return entry.name.endsWith('.tsx') ? [join(dir, entry.name)] : [];
  });
}

const ROOTS = ['apps/customer-web', 'apps/organizer-web', 'apps/admin-web', 'packages/web-kit/src'];

const offenders = [];
for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    const source = codeOnly(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(PATTERN)) {
      const [, prefix, raw] = match;
      const name = raw.split('/')[0];
      if (BUILTIN.test(name)) continue;
      if (NOT_A_COLOUR[prefix]?.test(name)) continue;
      if (prefix === 'text' && fontSizes.has(name)) continue;
      if (colours.has(name)) continue;
      offenders.push(`${file}: ${prefix}-${name}`);
    }
  }
}

if (offenders.length > 0) {
  console.error(
    `\n${offenders.length} class(es) name a design token that does not exist.\n` +
      `Tailwind generates NOTHING for these, so the element is silently unstyled:\n`,
  );
  for (const o of offenders) console.error(`  ${o}`);
  console.error(`\nColours: ${[...colours].sort().join(', ')}`);
  console.error(`Type scale: ${[...fontSizes].sort().join(', ')}\n`);
  process.exit(1);
}
console.log(
  `Design tokens: every colour and type class resolves ` +
    `(${colours.size} colours, ${fontSizes.size} sizes, ${ROOTS.length} roots).`,
);
