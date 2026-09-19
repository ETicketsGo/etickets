# Expo SDK 57 upgrade (done, 19 September 2026)

The Hermes V1 memory regression that `expo-doctor` reported against every build of this app is
fixed. SDK 57 carries React Native 0.86.3, which ships the patched Hermes, and the doctor check
now passes on its own rather than being deferred in CI.

|                           | before  | after   |
| ------------------------- | ------- | ------- |
| `expo`                    | 56.0.22 | 57.0.24 |
| `react-native`            | 0.85.3  | 0.86.3  |
| `react-native-reanimated` | 4.3.1   | 4.5.1   |
| `react-native-worklets`   | 0.8.3   | 0.10.1  |
| every `expo-*` package    | ~56.0.x | ~57.0.x |

**No application code changed.** All 197 tests in 20 suites pass unchanged, the typecheck and lint
are clean, the web export builds, and `expo config --type introspect` runs every config plugin with
no warnings. The areas most likely to break in an SDK jump were checked one by one:
`expo-splash-screen` plugin props, `expo-notifications` behaviour flags, `expo-image`, and the 23
`expo-router` import sites.

## Still outstanding: verify on a device

This upgrade has NOT been run on a physical device or an emulator, because this environment has no
Android SDK, Java, adb or macOS. A major React Native bump is exactly where a native-only
regression hides, and neither the web export nor the unit tests can see one.

The strongest offline evidence is the autolinking gate in CI, which passes: all 10 native modules
resolve to a single app-level copy, so no duplicate reaches the build. **Do a device pass or an EAS
dev build before any release that includes this.**

## What is still deferred, and why

`expo-doctor` still fails one check: duplicate dependencies. nativewind nests its own `react`,
`react-native`, `react-native-reanimated` and `react-native-worklets`, because
`react-native-css-interop` declares wide-open peers (`react-native: "*"`) and npm installs fresh
copies rather than reusing the app's. npm `overrides` do not reach auto-installed peers; that was
tried and reverted.

SDK 57 neither resolved nor worsened this — the nested set is the same five packages at the same
one-minor offset. The only thing that changes it is `nativewind@5`, which is a release candidate.
Swapping the styling layer for an RC does not belong in an SDK upgrade, so it is a separate
decision.

## The trap, for whoever does SDK 58

`expo install --fix` writes correct versions and can then still fail `npm install` with an
`ERESOLVE` naming a peer conflict that does not exist. npm resolves against the tree already
recorded in `package-lock.json`, so an old app-local copy blocks the new one from being placed.
Deleting `node_modules` does not help.

The fix is to prune the mobile subtree from the lockfile and reinstall from the root. Prune only
the mobile entries rather than regenerating the whole file, so the other workspaces do not re-float
underneath you. Afterwards prove the result is a fixpoint (a second `npm install --package-lock-only`
changes nothing) and that `npm ci` accepts it, because CI runs `npm ci`.

Also: `@react-native/jest-preset` is pinned to an exact version on purpose. React Native declares it
as an exact `peerOptional`, so a caret range falls out of range the moment the next patch ships and
npm then refuses to install the workspace at all.
