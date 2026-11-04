import { type ReactNode, useEffect, useState } from 'react';
import { Keyboard, Modal, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './text';
import { IconButton } from './button';

/**
 * Bottom sheet for secondary flows — filters, seat details, payment method choice.
 *
 * Built on RN's `Modal` rather than a gesture-driven sheet library: `Modal` is what
 * both platforms treat as a modal for accessibility, so VoiceOver and TalkBack trap
 * focus inside it and announce it as a dialog without any extra work. A hand-rolled
 * absolutely-positioned sheet leaves the screen behind it focusable, which is how a
 * screen-reader user ends up reading content they cannot see.
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  /** Sheets that must be answered (a payment result) opt out of tap-outside dismissal. */
  dismissable = true,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  dismissable?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight(visible);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      // Android's hardware back must close the sheet, not the screen underneath.
      onRequestClose={dismissable ? onClose : undefined}
      accessibilityViewIsModal
      statusBarTranslucent
    >
      <View className="flex-1 justify-end bg-black/40">
        <Pressable
          className="flex-1"
          // The scrim is a dismissal affordance for sighted users; a screen reader gets
          // the explicit Close button instead, so exposing it here would just add a
          // large unlabelled target.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          disabled={!dismissable}
          onPress={onClose}
        />
        <View
          className="rounded-t-xl border-t border-border bg-background-surface"
          // While the keyboard is open the sheet sits on it instead of on the screen edge.
          // Android reports the keyboard's height without the navigation bar under it, so
          // there the bottom inset is added back (measured on a moto g31: the button was
          // cut by exactly the gesture bar).
          style={{
            paddingBottom:
              (keyboard > 0
                ? keyboard + (Platform.OS === 'android' ? insets.bottom : 0)
                : insets.bottom) + 16,
          }}
        >
          {/* Grabber: a visual affordance only — it is not a control. */}
          <View className="items-center py-2.5" accessibilityElementsHidden>
            <View className="h-1 w-9 rounded-full bg-border-strong" />
          </View>

          <View className="flex-row items-center justify-between px-4 pb-2">
            <Text variant="title3" accessibilityRole="header" className="flex-1">
              {title}
            </Text>
            <IconButton icon="close" accessibilityLabel="Close" onPress={onClose} size={20} />
          </View>

          <View className="px-4">{children}</View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Height of the on-screen keyboard while the sheet is open.
 *
 * A Modal is its own window, and with `statusBarTranslucent` under Android's edge-to-edge
 * layout that window is NOT resized for the keyboard, so `adjustResize` and a
 * KeyboardAvoidingView in the screen below do nothing here. Found on a physical Android
 * phone: the refund reason box and "Send request" sat entirely behind the keyboard, so a
 * customer could not see what they typed. iOS never resizes for the keyboard either.
 */
function useKeyboardHeight(active: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!active) return;
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subs = [
      Keyboard.addListener(show, (e) => setHeight(e.endCoordinates.height)),
      Keyboard.addListener(hide, () => setHeight(0)),
    ];
    return () => {
      subs.forEach((s) => s.remove());
      setHeight(0);
    };
  }, [active]);
  return height;
}
