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

module.exports = withNativeWind(config, { input: './global.css' });
