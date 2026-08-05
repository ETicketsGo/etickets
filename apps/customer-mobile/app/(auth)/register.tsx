import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { registerSchema } from '@eticketsgo/validation';
import { Screen } from '@/components/screen';
import { Button, Field, IconButton, Text } from '@/ui';
import { useAuth } from '@/hooks/use-auth';
import { messageForError } from '@/services/errors';

/**
 * Create a customer account.
 *
 * Validation uses `registerSchema` from @eticketsgo/validation — the exact schema the
 * API validates against. Re-stating the rules here (min length, email shape) is how a
 * client ends up rejecting a password the server would have accepted, or accepting one
 * it won't.
 */
export default function RegisterScreen() {
  const router = useRouter();
  const { register } = useAuth();
  // Carried in when the user was sent here from somewhere that already knows the email.
  const { email: prefillEmail } = useLocalSearchParams<{ email?: string }>();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState(prefillEmail ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    const parsed = registerSchema.safeParse({ fullName, email: email.trim(), password });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        // First message per field: showing three password rules at once reads as a wall.
        if (!next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }

    setSubmitting(true);
    setErrors({});
    try {
      await register(parsed.data);
      // Back to wherever the user was — an account is almost never the destination, it
      // is something they were asked for on the way to a booking.
      if (router.canGoBack()) router.back();
      else router.replace('/(tabs)');
    } catch (err) {
      const message = messageForError(err);
      // The API distinguishes a duplicate email; putting that on the field rather than
      // in a generic banner is the difference between "try again" and knowing to sign in.
      if (/already|exists|registered/i.test(message)) {
        setErrors({ email: 'An account already exists with this email. Try signing in instead.' });
      } else {
        setErrors({ form: message });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen padded={false}>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center gap-1 px-2 py-1">
        <IconButton icon="close" accessibilityLabel="Close" onPress={() => router.back()} />
      </View>

      <KeyboardAvoidingView
        className="flex-1"
        // iOS pushes content up; Android's windowSoftInputMode already resizes, and
        // applying padding there double-counts and leaves a gap above the keyboard.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerClassName="gap-5 px-5 pb-8 pt-2"
          keyboardShouldPersistTaps="handled"
        >
          <View className="gap-1">
            <Text variant="largeTitle" accessibilityRole="header">
              Create account
            </Text>
            <Text variant="subhead" tone="muted">
              Keep every ticket in one place, on any device.
            </Text>
          </View>

          <View className="gap-3">
            <Field
              label="Full name"
              value={fullName}
              onChangeText={setFullName}
              error={errors.fullName}
              autoComplete="name"
              textContentType="name"
              editable={!submitting}
            />
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              error={errors.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              editable={!submitting}
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              error={errors.password}
              secure
              autoCapitalize="none"
              // `newPassword` is what prompts the OS to offer a strong password and to
              // save it to the keychain.
              autoComplete="new-password"
              textContentType="newPassword"
              editable={!submitting}
            />
          </View>

          {errors.form ? (
            <Text variant="subhead" tone="danger" accessibilityRole="alert">
              {errors.form}
            </Text>
          ) : null}

          <Button
            label="Create account"
            size="lg"
            loading={submitting}
            onPress={() => void onSubmit()}
          />

          <Button
            label="I already have an account"
            variant="ghost"
            onPress={() => router.replace({ pathname: '/(auth)/login', params: { email } })}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
