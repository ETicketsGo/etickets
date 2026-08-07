import { forwardRef, useId, useState } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme';
import { Text } from './text';

export interface FieldProps extends Omit<TextInputProps, 'className' | 'style'> {
  label: string;
  /** Validation message. Its presence is what puts the field in the error state. */
  error?: string;
  /** Persistent guidance shown when there is no error. */
  hint?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Renders a masked field with a reveal toggle. */
  secure?: boolean;
  containerClassName?: string;
  /** Minimum height for a multiline field. Ignored on single-line fields. */
  minHeight?: number;
}

/**
 * Labelled text field.
 *
 * The label is a real, always-visible label rather than a placeholder standing in for
 * one: a placeholder disappears the moment typing starts, which leaves the user with
 * no way to check what a half-filled field was asking for, and screen readers treat
 * it inconsistently.
 */
export const Field = forwardRef<TextInput, FieldProps>(function Field(
  {
    label,
    error,
    hint,
    icon,
    secure = false,
    containerClassName = '',
    editable = true,
    multiline = false,
    minHeight,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const errorId = useId();

  const border = error
    ? 'border-status-error'
    : focused
      ? 'border-action-primary'
      : 'border-border';

  return (
    <View className={`gap-1.5 ${containerClassName}`}>
      <Text variant="subhead" tone="secondary" className="font-medium">
        {label}
      </Text>

      <View
        /**
         * `collapsable={false}` PREVENTS A NATIVE CRASH. It is not a performance hint.
         *
         * Fabric flattens away Views that need no native view of their own, and the
         * `opacity-50` below appears only while `editable` is false. So toggling `editable`
         * changes whether this View exists natively, and Android then has to move the
         * TextInput between parents. A ReactEditText cannot be flattened, so it is a real
         * view with a real parent, and the move throws:
         *
         *   IllegalStateException: addViewAt: cannot insert view into parent:
         *   View already has a parent … View: ReactEditText
         *
         * which is an uncaught native exception — the app dies instantly, no error screen.
         * Reproduced 2/2 on Android 14 by submitting the Create-account form, whose fields
         * pass `editable={!submitting}`: the account was created server-side and then the
         * process crashed, so the user saw the launcher and assumed it had failed. The
         * login screen escaped only because it happens to use its own local field
         * component and never toggles `editable`.
         *
         * Opting out of flattening keeps this View native in both states, so the TextInput
         * never changes parent. The cost is one always-present view per field.
         */
        collapsable={false}
        className={`flex-row gap-2 rounded-md border bg-background-surface px-3 ${border} ${
          // A multiline field's icon and reveal button belong at the top, beside the
          // first line, not floating in the vertical middle of a growing box.
          multiline ? 'items-start pt-3' : 'items-center'
        } ${editable ? '' : 'opacity-50'}`}
        style={{ minHeight: multiline ? (minHeight ?? 120) : 48 }}
      >
        {icon ? <Ionicons name={icon} size={18} color={colors.textMuted} /> : null}
        <TextInput
          ref={ref}
          editable={editable}
          secureTextEntry={secure && !revealed}
          placeholderTextColor={colors.textMuted}
          // The visible label is the accessible name; without this the field would be
          // announced by its value alone.
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          // RN maps this to aria-invalid on web and to the native error trait on iOS.
          aria-invalid={Boolean(error)}
          aria-errormessage={error ? errorId : undefined}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          multiline={multiline}
          // Android centres multiline text vertically by default, which looks like a
          // rendering fault in a tall box. iOS ignores this.
          textAlignVertical={multiline ? 'top' : 'auto'}
          className="flex-1 py-3 font-sans text-body text-text-primary"
          maxFontSizeMultiplier={1.6}
          {...rest}
        />
        {secure ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={revealed ? `Hide ${label}` : `Show ${label}`}
            onPress={() => setRevealed((v) => !v)}
            hitSlop={12}
            className="active:opacity-60"
          >
            <Ionicons name={revealed ? 'eye-off' : 'eye'} size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {error ? (
        // `alert` so the message is announced when it appears, not only when the user
        // navigates back to the field.
        <Text nativeID={errorId} accessibilityRole="alert" variant="footnote" tone="danger">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="footnote" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
});
