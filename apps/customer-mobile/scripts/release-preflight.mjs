#!/usr/bin/env node
/**
 * Which optional integrations will the NEXT build of an EAS environment switch on?
 *
 * Read-only. Lists the variable NAMES in an EAS environment (`eas env:list`) and says, for
 * push (Firebase), crash reporting (Sentry) and the Play Integrity bot check, whether the build
 * will have it, and what is missing. It never prints a value. Run it before building a new
 * version, and update the Play Data safety form BEFORE releasing a build that turns
 * something on.
 *
 *   node scripts/release-preflight.mjs [production|preview]
 *
 * The API side of Play Integrity is configured on Railway (PLAY_INTEGRITY_*), not in EAS, so
 * it is listed as a reminder only. See docs/PLAY-RELEASE.md section 6.
 */
import { execFileSync } from 'node:child_process';

const environment = process.argv[2] ?? 'production';
if (!['production', 'preview', 'development'].includes(environment)) {
  console.error(`Unknown EAS environment: ${environment}`);
  process.exit(2);
}

let listing;
try {
  listing = execFileSync('npx', ['-y', 'eas-cli', 'env:list', '--environment', environment], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
} catch (err) {
  console.error('Could not list EAS variables (are you logged in to the Expo account?).');
  console.error(String(err.stderr ?? err.message).split('\n')[0]);
  process.exit(2);
}

// Lines look like NAME=value or NAME=***** ; keep the name only.
const names = new Set(
  listing
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
    .map((l) => l.slice(0, l.indexOf('='))),
);
const has = (n) => names.has(n);

const rows = [];
const problems = [];

rows.push([
  'Push notifications (Firebase via Expo)',
  has('GOOGLE_SERVICES_JSON') ? 'ON' : 'off',
  has('GOOGLE_SERVICES_JSON')
    ? 'Also needs: FCM V1 key in Expo credentials; PUSH_PROVIDER=expo on api + worker.'
    : 'Add GOOGLE_SERVICES_JSON (file, secret) to turn it on.',
]);

const sentry = has('EXPO_PUBLIC_SENTRY_DSN');
rows.push([
  'Crash reporting (Sentry)',
  sentry ? 'ON' : 'off',
  sentry
    ? has('SENTRY_AUTH_TOKEN')
      ? 'Source maps upload with SENTRY_AUTH_TOKEN.'
      : 'No SENTRY_AUTH_TOKEN: stack traces will be minified.'
    : 'Add EXPO_PUBLIC_SENTRY_DSN to turn it on.',
]);
if (has('SENTRY_AUTH_TOKEN') && has('SENTRY_DISABLE_AUTO_UPLOAD')) {
  problems.push('SENTRY_AUTH_TOKEN is set but SENTRY_DISABLE_AUTO_UPLOAD still disables uploads.');
}
if (
  !has('SENTRY_AUTH_TOKEN') &&
  !has('SENTRY_DISABLE_AUTO_UPLOAD') &&
  environment === 'production'
) {
  problems.push(
    'Neither SENTRY_AUTH_TOKEN nor SENTRY_DISABLE_AUTO_UPLOAD: the production build fails at the source-map upload.',
  );
}

rows.push([
  'Play Integrity bot check',
  'server-side',
  'Built into every build. Active only when the API has PLAY_INTEGRITY_* and TURNSTILE_MODE is not off.',
]);

console.log(`EAS environment: ${environment}`);
console.log(`Variables present (names only): ${[...names].sort().join(', ') || '(none)'}`);
console.log('');
for (const [what, state, note] of rows) console.log(`- ${what}: ${state}. ${note}`);
if (rows.some(([, state]) => state === 'ON')) {
  console.log('\nSomething is ON: update the Play Data safety form before releasing this build.');
}
if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}
