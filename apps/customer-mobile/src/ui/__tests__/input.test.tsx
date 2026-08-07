import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { Field } from '../input';

/**
 * A unit test cannot reproduce a native view-flattening crash — it happens in Fabric's
 * Android mounting layer, which jest does not run. What it CAN do is stop the one-word
 * change that reintroduces it.
 *
 * `editable` toggles an `opacity-50` class on the field's wrapper View. Under Fabric that
 * changes whether the View exists natively at all, and Android then re-parents the
 * TextInput inside it — which throws, because a ReactEditText is never flattened and so
 * already has a parent. The app dies with an uncaught native exception and no error
 * screen. Reproduced 2/2 on Android 14 by submitting the Create-account form, whose
 * fields pass `editable={!submitting}`.
 *
 * `collapsable={false}` keeps the wrapper native in both states. These assertions exist
 * so deleting it fails here rather than in a release build.
 */
const wrappers = (tree: unknown): Record<string, unknown>[] => {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const n = node as { props?: Record<string, unknown>; children?: unknown };
    // The wrapper is identified by the style it always carries, so the test does not
    // depend on class-name details that Tailwind may compile differently.
    if (n.props && 'collapsable' in n.props) found.push(n.props);
    walk(n.children);
  };
  walk(tree);
  return found;
};

describe('Field flattening opt-out', () => {
  it('opts the input wrapper out of view flattening when editable', async () => {
    await render(<Field label="Email" value="" onChangeText={() => undefined} />);

    const opted = wrappers(screen.toJSON()).filter((p) => p.collapsable === false);
    expect(opted.length).toBeGreaterThan(0);
  });

  it('opts out while NOT editable too — the transition is what crashes', async () => {
    await render(<Field label="Email" value="" onChangeText={() => undefined} editable={false} />);

    const opted = wrappers(screen.toJSON()).filter((p) => p.collapsable === false);
    expect(opted.length).toBeGreaterThan(0);
  });

  it('still renders the label and an error message', async () => {
    await render(
      <Field
        label="Password"
        value=""
        onChangeText={() => undefined}
        error="Use at least 8 characters."
      />,
    );

    expect(screen.getByText('Password')).toBeTruthy();
    expect(screen.getByText('Use at least 8 characters.')).toBeTruthy();
  });
});
