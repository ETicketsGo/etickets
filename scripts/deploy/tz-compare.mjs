#!/usr/bin/env node
/**
 * Compare time-zone behaviour between two Node images, using the REAL conversion and formatting
 * code of a git ref (extracted verbatim, bundled with esbuild). Run before any Node upgrade.
 *
 *   node scripts/deploy/tz-compare.mjs [--ref origin/main] [--a node:20.20.2-alpine]
 *        [--b node:24.22.2-alpine] [--out <dir>]
 *
 * Needs Docker. Prints every row that differs between the two images and exits 1 if any does,
 * so a tzdata change can never ride along with a runtime upgrade unnoticed.
 * Background and the 2026-11-06 result: docs/deployment/NODE-24-TIMEZONE-REGRESSION.md.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc),
      [],
    ),
);
const ref = args.ref ?? 'origin/main';
const imageA = args.a ?? 'node:20.20.2-alpine';
const imageB = args.b ?? 'node:24.22.2-alpine';
const REPO = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const OUT = path.resolve(args.out ?? mkdtempSync(path.join(tmpdir(), 'tz-compare-')));
const show = (p) =>
  execFileSync('git', ['-C', REPO, 'show', `${ref}:${p}`], { encoding: 'utf8', maxBuffer: 64e6 });

function extract(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`not found in ${ref}: ${signature}`);
  return src.slice(start, src.indexOf('\n}\n', start) + 3);
}

mkdirSync(path.join(OUT, 'src'), { recursive: true });
const shows = show('apps/api/src/shows/shows.service.ts');
const sms = show('apps/api/src/notifications/templates/dlt-sms-templates.ts');
writeFileSync(
  path.join(OUT, 'src/extracted.ts'),
  [
    `// Extracted verbatim from ${ref}.`,
    extract(shows, 'export function zonedWallClockToInstant('),
    extract(shows, 'export function instantToZonedWallClock('),
    extract(sms, 'export function formatShowTime('),
  ].join('\n\n'),
);
writeFileSync(path.join(OUT, 'src/zoned-time.ts'), show('apps/organizer-web/lib/zoned-time.ts'));
writeFileSync(
  path.join(OUT, 'src/probe.ts'),
  `import { zonedWallClockToInstant, instantToZonedWallClock, formatShowTime } from './extracted';
import { wallClockToInstant, instantToWallClock } from './zoned-time';
import { zoneAbbrev } from '@eticketsgo/shared-types';
const ZONES = ['America/Vancouver', 'America/Los_Angeles', 'America/Toronto', 'America/New_York', 'Asia/Kolkata', 'Europe/London'];
const WALL = [
  ['2026-03-07','19:00'], ['2026-03-08','02:30'], ['2026-03-08','19:00'], ['2026-03-29','19:00'],
  ['2026-10-25','19:00'], ['2026-10-31','19:00'], ['2026-11-01','01:30'], ['2026-11-01','19:00'],
  ['2026-11-06','19:00'], ['2026-12-20','19:00'], ['2027-03-13','19:00'], ['2027-03-14','02:30'],
  ['2027-03-14','19:00'], ['2027-11-07','01:30'], ['2027-11-07','19:00'],
];
const STORED = ['2026-11-07T03:00:00.000Z', '2026-12-21T03:00:00.000Z', '2027-01-16T03:00:00.000Z', '2027-03-15T02:00:00.000Z'];
const emailClock = (iso: string, timeZone: string) => {
  const at = new Date(iso);
  return at.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone }) + ' ' + zoneAbbrev(at, timeZone);
};
const rows: unknown[] = [];
for (const zone of ZONES) {
  for (const [d, t] of WALL) {
    const api = zonedWallClockToInstant(d, t, zone).toISOString();
    const web = wallClockToInstant(d + 'T' + t, zone).toISOString();
    rows.push({ kind: 'wall->utc', zone, wall: d + ' ' + t, api, web, back: instantToZonedWallClock(new Date(api), zone) });
  }
  for (const iso of STORED) {
    rows.push({ kind: 'stored->display', zone, stored: iso, ticket: instantToWallClock(iso, zone), email: emailClock(iso, zone), sms: formatShowTime(iso, zone) });
  }
}
console.log(JSON.stringify({ node: process.version, tz: (process.versions as Record<string, string>).tz ?? null, rows }));
`,
);
execSync(
  `npx esbuild "${path.join(OUT, 'src/probe.ts')}" --bundle --platform=node --format=esm --log-level=warning ` +
    `--outfile="${path.join(OUT, 'tz-probe.mjs')}" ` +
    `--alias:@eticketsgo/shared-types="${path.join(REPO, 'packages/shared-types/src/index.ts')}"`,
  { cwd: REPO, stdio: 'inherit' },
);
const run = (image) =>
  JSON.parse(
    execFileSync('docker', ['run', '--rm', '-v', `${OUT}:/p`, image, 'node', '/p/tz-probe.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    }),
  );
const a = run(imageA);
const b = run(imageB);
console.log(`${imageA}: node ${a.node}, tzdata ${a.tz}`);
console.log(`${imageB}: node ${b.node}, tzdata ${b.tz}`);
let differ = 0;
a.rows.forEach((r, i) => {
  const s = b.rows[i];
  const keys = Object.keys(r).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(s[k]));
  if (!keys.length) return;
  differ++;
  console.log(
    `${r.zone} ${r.kind} ${r.wall ?? r.stored}: ` +
      keys.map((k) => `${k} ${r[k]} -> ${s[k]}`).join('; '),
  );
});
const gaps = b.rows.filter((r) => r.kind === 'wall->utc' && r.api !== r.web).length;
console.log(
  `rows ${a.rows.length}, differ ${differ}; api/console disagreements in ${imageB}: ${gaps} (spring-forward gaps, AR-26)`,
);
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ a, b }, null, 2));
process.exit(differ ? 1 : 0);
