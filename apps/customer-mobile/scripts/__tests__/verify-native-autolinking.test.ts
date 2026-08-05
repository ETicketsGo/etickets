/**
 * The nesting detector, tested on its own.
 *
 * The script it guards shells out to the autolinker, so the interesting logic — "is
 * this path inside another package's node_modules?" — is worth pinning separately. A
 * gate that cannot fail is not a gate, and this one is the only thing standing between
 * a duplicate native module and a Gradle build.
 */

/** Mirrors the check in scripts/verify-native-autolinking.mjs. */
function isNestedCopy(root: string): boolean {
  const path = root.split('\\').join('/');
  const marker = '/node_modules/';
  const first = path.indexOf(marker);
  if (first === -1) return false;
  return path.slice(first + marker.length).includes(marker);
}

describe('nested native module detection', () => {
  it('accepts a module resolved from the app', () => {
    expect(isNestedCopy('C:/repo/apps/customer-mobile/node_modules/react-native-reanimated')).toBe(
      false,
    );
  });

  it('accepts a module hoisted to the workspace root', () => {
    expect(isNestedCopy('C:/repo/node_modules/@react-native-community/netinfo')).toBe(false);
  });

  it('REJECTS a module resolved from inside another package', () => {
    // The exact case: nativewind's own reanimated being handed to Gradle alongside the
    // app's would put two copies of one native module in a single binary.
    expect(
      isNestedCopy('C:/repo/node_modules/nativewind/node_modules/react-native-reanimated'),
    ).toBe(true);
  });

  it('handles Windows backslash paths, which is what the autolinker emits here', () => {
    expect(
      isNestedCopy('C:\\repo\\node_modules\\nativewind\\node_modules\\react-native-worklets'),
    ).toBe(true);
    expect(
      isNestedCopy('C:\\repo\\apps\\customer-mobile\\node_modules\\react-native-screens'),
    ).toBe(false);
  });

  it('does not mistake a scoped package for nesting', () => {
    expect(isNestedCopy('/repo/node_modules/@react-native-async-storage/async-storage')).toBe(
      false,
    );
  });

  it('treats a path with no node_modules at all as not nested', () => {
    // Local/linked modules resolve outside node_modules; they are not duplicates.
    expect(isNestedCopy('/repo/packages/some-local-native-module')).toBe(false);
  });
});
