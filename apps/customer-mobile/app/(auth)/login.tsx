import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { AxiosError } from 'axios';
import { loginSchema } from '@eticketsgo/validation';
import { Screen } from '@/components/screen';
import { BrandMark } from '@/components/brand-mark';
import { Button, Card, Field, IconButton, Text, haptics } from '@/ui';
import { useAuth } from '@/hooks/use-auth';
import { messageForError } from '@/services/errors';
import { webUrl } from '@/services/legal';

/**
 * Sign in, laid out as the storefront's sign-in card: a title, the fields, one ink button,
 * and the two ways out (create an account, reset a password).
 *
 * Email and password only. The storefront also signs in by phone code, but the API guards
 * that route with a browser human check a native app cannot run; see the release notes.
 * Password reset happens on the website, which already has the whole flow.
 */
export default function Login() {
  const { login } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(params.email ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    const parsed = loginSchema.safeParse({ email: email.trim(), password });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === 'email' ? 'email' : 'password';
        if (!next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await login(parsed.data);
      // Sign-in is a modal over whatever asked for it (checkout, tickets, account).
      // Closing it returns there; nothing else redirects.
      if (router.canGoBack()) router.back();
      else router.replace('/(tabs)');
    } catch (err) {
      // Only a refusal from the server means the password was wrong. "No signal" told as
      // "wrong password" sends people to reset a password that works.
      const refused =
        err instanceof AxiosError && (err.response?.status === 401 || err.response?.status === 400);
      setErrors({ form: refused ? 'The email or password is not right.' : messageForError(err) });
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
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <ScrollView
          contentContainerClassName="px-4 pb-10 pt-6"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <Card className="gap-5 p-6">
            <View className="gap-1">
              <Text variant="d1" accessibilityRole="header">
                Sign in
              </Text>
              <Text variant="ui" tone="secondary">
                Your tickets are in your account, on any device.
              </Text>
            </View>

            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              error={errors.email}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              error={errors.password}
              secure
              autoCapitalize="none"
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void onSubmit()}
            />

            {errors.form ? (
              <Card tone="sunken" className="border-l-4 border-critical">
                <Text variant="ui" tone="danger" accessibilityRole="alert" className="font-medium">
                  {errors.form}
                </Text>
              </Card>
            ) : null}

            <Button
              label="Sign in"
              size="lg"
              loading={submitting}
              onPress={() => void onSubmit()}
            />

            <Pressable
              accessibilityRole="link"
              onPress={() => {
                haptics.tap();
                void WebBrowser.openBrowserAsync(webUrl('/forgot-password'));
              }}
              className="self-start border-b border-gold pb-0.5 active:opacity-60"
              hitSlop={8}
            >
              <Text variant="ui" className="font-semibold">
                Forgot your password?
              </Text>
            </Pressable>

            <View className="h-px bg-border" />

            <View className="flex-row flex-wrap items-center gap-1">
              <Text variant="ui" tone="muted">
                No account?
              </Text>
              <Pressable
                accessibilityRole="link"
                onPress={() =>
                  router.replace({ pathname: '/(auth)/register', params: { email: email.trim() } })
                }
                hitSlop={8}
                className="border-b border-gold pb-0.5 active:opacity-60"
              >
                <Text variant="ui" className="font-semibold">
                  Create one
                </Text>
              </Pressable>
            </View>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
