#!/usr/bin/env node
/**
 * Prove that no duplicate native module reaches the Android/iOS build.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────
 * expo-doctor fails this project on "duplicate native module dependencies". The
 * duplicates are real: nativewind pulls its own react, react-native, reanimated and
 * worklets into node_modules/nativewind/node_modules, because react-native-css-interop
 * declares wide-open peers (`react-native: "*"`, `reanimated: ">=3.6.2"`) and npm
 * installs fresh copies rather than reusing the app's. They cannot be deduplicated with
 * npm `overrides` — overrides do not reach auto-installed peers, which was tried and
 * reverted.
 *
 * But expo-doctor's check is about what is IN node_modules. What decides the build is
 * what the AUTOLINKER resolves, and those are different questions. CI previously
 * answered the first one with a hardcoded allow-list of package names
 * ("react, react-dom and react-native-screens duplicates are fine"), which went stale
 * the moment the duplicate set changed — and did on this branch, turning a green gate
 * red for a condition nobody had re-examined.
 *
 * This asks the second question instead: for every native module the autolinker will
 * hand to Gradle, is it resolved from the app, or from inside nativewind? A duplicate
 * that never reaches the build is inert; one that does would produce two copies of a
 * native module in one binary, which is the failure expo-doctor is warning about.
 *
 * Stronger than the allow-list it replaces, because it does not care what the duplicate
 * set looks like — only whether any of it is about to be compiled.
 */
import { execFileSync } from 'node:child_process';

const platform = process.argv[2] ?? 'android';

let config;
try {
  // shell:true because on Windows npx is a .cmd, and Node 24 refuses to spawnSync a
  // batch file directly (EINVAL). The argv is fixed and contains no user input.
  const raw = execFileSync(
    'npx',
    ['expo-modules-autolinking', 'react-native-config', '--platform', platform, '--json'],
    {
      cwd: process.cwd(),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true,
    },
  ).toString();
  config = JSON.parse(raw);
} catch (error) {
  console.error(`Could not read autolinking config for ${platform}: ${String(error).slice(0, 200)}`);
  process.exit(1);
}

const dependencies = config.dependencies ?? {};
const names = Object.keys(dependencies);

if (names.length === 0) {
  // A silent empty result would make this script pass by doing nothing.
  console.error('Autolinking reported no native modules at all — that is not plausible.');
  process.exit(1);
}

/** Any node_modules folder that is not the app's own or the workspace root. */
const NESTED_MARKER = '/node_modules/';

const offenders = [];
for (const name of names) {
  const root = String(dependencies[name].root ?? '').split('\\').join('/');
  // A module resolved from inside ANOTHER package's node_modules is a nested copy.
  const afterFirst = root.slice(root.indexOf(NESTED_MARKER) + NESTED_MARKER.length);
  if (afterFirst.includes(NESTED_MARKER)) {
    offenders.push({ name, root });
  }
}

console.log(`${platform}: ${names.length} autolinked native modules`);

if (offenders.length > 0) {
  console.error('\nThese would be built from a nested copy rather than the app’s own:');
  for (const offender of offenders) {
    console.error(`  ${offender.name}\n    ${offender.root}`);
  }
  console.error(
    '\nTwo copies of one native module in a single binary is the condition expo-doctor ' +
      'warns about. Resolve the duplicate before building.',
  );
  process.exit(1);
}

console.log('Every native module resolves to a single app-level copy — safe to build.');
