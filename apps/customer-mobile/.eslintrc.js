// Expo's ESLint config (RN + a11y rules). Isolated from the web apps' config so the
// two toolchains never interfere.
module.exports = {
  root: true,
  extends: ['expo'],
  ignorePatterns: ['/dist', '/.expo', 'node_modules'],
};
