import React from 'react';
import { Keyboard, StyleSheet, Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Sheet } from '../sheet';

/**
 * The sheet is a Modal window, which Android does not resize for the keyboard. On a
 * physical phone the refund reason box and "Send request" sat behind the keyboard. The
 * sheet must lift itself by the keyboard's height, and drop back when it closes.
 */
type Handler = (e: { endCoordinates: { height: number } }) => void;

describe('Sheet and the keyboard', () => {
  const handlers: Record<string, Handler> = {};

  beforeEach(() => {
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, fn: Handler) => {
      handlers[event] = fn;
      return { remove: () => delete handlers[event] };
    }) as unknown as typeof Keyboard.addListener);
  });

  afterEach(() => jest.restoreAllMocks());

  const panelPadding = () => {
    // The panel is the View that holds the title.
    let node = screen.getByText('Ask for a refund').parent;
    while (node && StyleSheet.flatten(node.props.style)?.paddingBottom === undefined) {
      node = node.parent;
    }
    return StyleSheet.flatten(node?.props.style)?.paddingBottom;
  };

  it('sits on the keyboard while it is open', async () => {
    await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <Sheet visible onClose={() => {}} title="Ask for a refund">
          <Text>Reason</Text>
        </Sheet>
      </SafeAreaProvider>,
    );
    const resting = panelPadding();
    expect(resting).toBe(50);
    const show = handlers.keyboardDidShow ?? handlers.keyboardWillShow;
    const hide = handlers.keyboardDidHide ?? handlers.keyboardWillHide;
    expect(show).toBeDefined();

    await act(() => show!({ endCoordinates: { height: 300 } }));
    // jest runs as iOS: the keyboard height plus the 16 of spacing.
    expect(panelPadding()).toBe(316);

    await act(() => hide!({ endCoordinates: { height: 0 } }));
    expect(panelPadding()).toBe(resting);
  });
});
