#!/usr/bin/env node
/**
 * Draws the browser-tab and home-screen icons for the three web apps.
 *
 *   node scripts/brand/generate-favicons.mjs
 *
 * ── WHY A SCRIPT ───────────────────────────────────────────────────────────────────
 * Each app needs the same mark at eight sizes and in three file types (SVG, PNG, ICO). Drawn
 * by hand, those copies drift: the storefront's tab icon was still the purple/blue "E" ticket
 * long after the brand moved to paper, ink and the marigold light, and the two consoles had no
 * icon at all (every tab showed the browser's blank page). One drawing here, every file below
 * rendered from it. The output is committed, so a build never runs this.
 *
 * ── THE MARK ───────────────────────────────────────────────────────────────────────
 * The wordmark's own ending: an "E" and the marigold full stop ("ETicketsGo." in the header).
 * Blocky and pixel-aligned rather than set in the display face: at 16px a tab icon is a
 * 16x16 grid, and the E's three bars are each exactly two pixels tall with two-pixel gaps, so
 * they stay three bars instead of blurring into a grey block. The drawing is a path, not text,
 * so it does not depend on which fonts the renderer has.
 *
 * ── ONE BRAND, THREE TABS ──────────────────────────────────────────────────────────
 * People run the storefront, the organizer console and the admin console side by side, and
 * a tab is recognised by colour before it is read. Same glyph, three of the brand's own
 * colours (packages/design-tokens/src/brand.css):
 *
 *   customer   paper tile, ink E, marigold dot   - the wordmark as the storefront prints it
 *   organizer  ink tile, paper E, marigold dot   - the same wordmark with the lights down
 *   admin      marigold tile, ink E, ink dot     - the loudest one, because it is the one
 *                                                  where an action in the wrong tab costs most
 *
 * Marigold only ever carries ink, as the brand rules require.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PAPER = '#FBF9F5';
const INK = '#17140F';
const MARIGOLD = '#FFB81A';

const APPS = {
  'customer-web': { tile: PAPER, glyph: INK, dot: MARIGOLD, edge: '#E4DED3' },
  'organizer-web': { tile: INK, glyph: PAPER, dot: MARIGOLD, edge: null },
  'admin-web': { tile: MARIGOLD, glyph: INK, dot: INK, edge: null },
};

/*
  On a 512 box, 32 units are one pixel of a 16px icon. Every edge of the E sits on that grid:
  bars at y 96-160, 224-288, 352-416 (two pixels each, two-pixel gaps), stem 64 wide.
  The group is shifted 16 units left so the E-plus-dot is centred, which puts the vertical
  edges on half pixels at 16px; the horizontal edges, the ones that separate the bars, stay
  whole.
*/
const GLYPH = 'M80 96H304V160H144V224H272V288H144V352H304V416H80Z';
const DOT = { cx: 384, cy: 368, r: 48 };

/**
 * The mark as SVG.
 * `bleed`: fill the whole square (home screens and iOS draw their own corner shape).
 * `scale`: shrink the glyph toward the centre, for the maskable safe zone.
 */
function svg({ tile, glyph, dot, edge }, { bleed = false, scale = 1 } = {}) {
  const shape = bleed
    ? `<rect width="512" height="512" fill="${tile}"/>`
    : `<rect x="8" y="8" width="496" height="496" rx="104" fill="${tile}"${
        edge ? ` stroke="${edge}" stroke-width="16"` : ''
      }/>`;
  const t =
    scale === 1 ? '' : ` transform="translate(256 256) scale(${scale}) translate(-256 -256)"`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="ETicketsGo">',
    '<title>ETicketsGo</title>',
    shape,
    `<g${t}>`,
    `<path fill="${glyph}" d="${GLYPH}"/>`,
    `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="${dot}"/>`,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

const png = (source, size) =>
  sharp(Buffer.from(source), { density: Math.max(72, (72 * size) / 512) * 4 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

/** A .ico holding PNG images (supported by every browser that still asks for one). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

for (const [app, colours] of Object.entries(APPS)) {
  const out = join(ROOT, 'apps', app, 'public');
  mkdirSync(out, { recursive: true });
  const rounded = svg(colours);
  // 0.64: the E-plus-dot then stays inside the central 80% circle a launcher may crop to.
  const maskable = svg(colours, { bleed: true, scale: 0.64 });
  // iOS rounds the corners itself and paints transparent pixels black, so this one bleeds.
  const apple = svg(colours, { bleed: true, scale: 0.8 });

  const files = {
    'icon.svg': rounded,
    'icon-maskable.svg': maskable,
    'icon-16.png': await png(rounded, 16),
    'icon-32.png': await png(rounded, 32),
    'icon-192.png': await png(rounded, 192),
    'icon-512.png': await png(rounded, 512),
    'icon-maskable-192.png': await png(maskable, 192),
    'icon-maskable-512.png': await png(maskable, 512),
    'apple-touch-icon.png': await png(apple, 180),
    'favicon.ico': ico([
      { size: 16, data: await png(rounded, 16) },
      { size: 32, data: await png(rounded, 32) },
      { size: 48, data: await png(rounded, 48) },
    ]),
  };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(out, name), data);
  console.log(`${app}: ${Object.keys(files).length} files in apps/${app}/public`);
}
