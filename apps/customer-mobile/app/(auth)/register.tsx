import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { registerSchema } from '@eticketsgo/validation';
import { PASSWORD_MIN_LENGTH } from '@eticketsgo/shared-types';
import { Screen } from '@/components/screen';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Field, IconButton, Text, haptics } from '@/ui';
import { BrandMark } from '@/components/brand-mark';
import { useAuth } from '@/hooks/use-auth';
import { messageForError } from '@/services/errors';
import { authRepository } from '@/data/auth-repository';
import { PhoneSignIn } from '@/features/auth/phone-sign-in';

/**
 * Create a customer account.
 *
 * Validation uses `registerSchema` from @eticketsgo/validation — the exact schema the
 * API validates against. Re-stating the rules here (min length, email shape) is how a
 * client ends up rejecting a password the server would have accepted, or accepting one
 * it won't.
 *
 * Mobile | Email, as on the storefront's /register and on this app's sign-in. The Mobile tab is
 * sign-UP by text code (`PhoneSignIn signUp`): it asks for a name, and when the number already
 * has an account it says "You already have an account with this number. We signed you in."
 * instead of behaving as if one had just been made.
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
  const reachable = useQuery({
    queryKey: ['capabilities', 'phoneSignInCountries'],
    queryFn: authRepository.phoneSignInCountries,
    staleTime: 10 * 60_000,
  });
  const [chosenTab, setChosenTab] = useState<'phone' | 'email' | null>(
    prefillEmail ? 'email' : null,
  );
  // The same rule as sign-in: Mobile first wherever this environment can text a code.
  const tab = chosenTab ?? (reachable.data && reachable.data.length > 0 ? 'phone' : 'email');
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

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
      <View className="flex-row items-center justify-between px-3 py-1.5">
        <IconButton
          icon="close"
          accessibilityLabel="Close"
          tone="outlined"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
        />
        <BrandMark />
        <View style={{ width: 44 }} />
      </View>

      <KeyboardAvoidingView
        className="flex-1"
        // iOS pushes content up; Android's windowSoftInputMode already resizes, and
        // applying padding there double-counts and leaves a gap above the keyboard.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerClassName="px-4 pb-10 pt-6"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <Card className="gap-5 p-6">
            <View className="gap-1">
              <Text variant="d1" accessibilityRole="header">
                Create an account
              </Text>
              <Text variant="ui" tone="secondary">
                Keep every ticket in one place, on any device.
              </Text>
            </View>

            <View
              accessibilityRole="tablist"
              className="flex-row rounded-control border border-border-strong p-1"
            >
              {(
                [
                  ['phone', 'Mobile'],
                  ['email', 'Email'],
                ] as const
              ).map(([key, label]) => (
                <Pressable
                  key={key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: tab === key }}
                  onPress={() => {
                    haptics.select();
                    setChosenTab(key);
                  }}
                  style={{ minHeight: 44 }}
                  className={[
                    'flex-1 items-center justify-center rounded-control',
                    tab === key ? 'bg-ink' : 'active:bg-sunken',
                  ].join(' ')}
                >
                  <Text
                    variant="ui"
                    tone={tab === key ? 'onAccent' : 'primary'}
                    className="font-semibold"
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {tab === 'phone' ? (
              <PhoneSignIn signUp onSignedIn={close} onUseEmail={() => setChosenTab('email')} />
            ) : (
              <>
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
                  hint={`At least ${PASSWORD_MIN_LENGTH} characters. Do not use your name or email.`}
                  secure
                  autoCapitalize="none"
                  // `newPassword` prompts the OS to offer a strong password and save it.
                  autoComplete="new-password"
                  textContentType="newPassword"
                  editable={!submitting}
                />

                {errors.form ? (
                  <Card tone="sunken" className="border-l-4 border-critical">
                    <Text
                      variant="ui"
                      tone="danger"
                      accessibilityRole="alert"
                      className="font-medium"
                    >
                      {errors.form}
                    </Text>
                  </Card>
                ) : null}

                <Button
                  label="Create account"
                  size="lg"
                  loading={submitting}
                  onPress={() => void onSubmit()}
                />
              </>
            )}

            <Text variant="meta" tone="muted">
              By creating an account you agree to the terms of service and the privacy policy,
              linked from Account.
            </Text>

            <View className="h-px bg-border" />

            <View className="flex-row flex-wrap items-center gap-1">
              <Text variant="ui" tone="muted">
                Already have an account?
              </Text>
              <Pressable
                accessibilityRole="link"
                onPress={() => router.replace({ pathname: '/(auth)/login', params: { email } })}
                hitSlop={8}
                className="border-b border-gold pb-0.5 active:opacity-60"
              >
                <Text variant="ui" className="font-semibold">
                  Sign in
                </Text>
              </Pressable>
            </View>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
