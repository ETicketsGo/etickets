// Flat config for ESLint 9. The monorepo root pins ESLint 8 (Next 14 `next lint`), so we
// cannot use `eslint-config-expo/flat` — it internally requires `eslint/config`, which the
// root-hoisted ESLint 8 does not export. Instead we bridge Expo's *legacy* (eslintrc) config
// (`eslint-config-expo/default.js`) into flat config with the official FlatCompat shim, which
// has no such dependency. This keeps the real Expo/React Native ruleset.
const path = require('path');
const { FlatCompat } = require('@eslint/eslintrc');

// The monorepo root hoists ESLint-8-era plugins (via eslint-config-next 14), e.g.
// eslint-plugin-react-hooks@5-canary which calls the removed `context.getScope()` under
// ESLint 9. Resolve plugins from eslint-config-expo's own node_modules instead, where the
// ESLint-9-compatible versions (react-hooks@7 etc.) live.
const expoConfigDir = path.dirname(require.resolve('eslint-config-expo/package.json'));

const compat = new FlatCompat({
  baseDirectory: __dirname,
  resolvePluginsRelativeTo: expoConfigDir,
});

module.exports = [
  ...compat.extends('eslint-config-expo/default.js'),
  {
    ignores: [
      'dist/*',
      '.expo/*',
      'expo-env.d.ts',
      'nativewind-env.d.ts',
      'node_modules/*',
      'babel.config.js',
      'metro.config.js',
      'eslint.config.js',
    ],
  },
  {
    // react-hooks@7 adds an `immutability` rule (React Compiler era) that flags any mutation
    // of a value returned from a hook. Reanimated's core API is exactly that — `sharedValue.value = ...`
    // — so the rule is a false positive for every animated component. Disable it for this RN app.
    rules: {
      'react-hooks/immutability': 'off',
    },
  },
  {
    // Build/test scripts run under Node, not in the app bundle. Expo's config declares
    // React Native globals, so without this URL, Buffer and AbortSignal read as undefined
    // here — a false positive, and one that would push someone toward adding globals to
    // the app's own environment to silence it.
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        // page.waitForFunction bodies run IN the browser, so DOM globals appear in
        // this Node file even though Node itself never evaluates them.
        document: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
  },
];
