// Monorepo-aware Metro config so the app resolves workspace packages
// (@eticketsgo/shared-types, /validation, /design-tokens) from the repo root,
// wrapped with NativeWind's CSS transformer.
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so changes in shared packages hot-reload.
config.watchFolders = [workspaceRoot];
// Resolve modules from the app first, then the hoisted root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Prefer the packages' compiled entry (they publish CJS `dist`).
config.resolver.disableHierarchicalLookup = false;

// CRITICAL (monorepo React isolation): the web apps use React 18 and are hoisted to the
// root, while this app needs React 19.2.x for RN 0.86. Force EVERY module — including the
// root-hoisted react-native — to resolve react/react-dom from THIS app's node_modules, so
// exactly one React runtime is bundled (prevents Invalid Hook Call / duplicate React).
config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, 'node_modules/react'),
  'react-dom': path.resolve(projectRoot, 'node_modules/react-dom'),
  // react-native for the same reason as react, and it is not hypothetical: nativewind pulls
  // its own react-native (0.86.2) into node_modules/nativewind/node_modules while this app
  // uses the Expo-SDK-aligned 0.85.3. An npm `overrides` entry does not constrain it — the
  // copy arrives as an auto-installed peer of react-native-css-interop. Two react-native
  // copies in one bundle means two native module registries and two copies of the component
  // types, which is how "className is not a prop" appears at build time and far stranger
  // things appear at runtime. Pinning the resolution here makes Metro bundle exactly one.
  'react-native': path.resolve(projectRoot, 'node_modules/react-native'),
};

module.exports = withNativeWind(config, { input: './global.css' });
