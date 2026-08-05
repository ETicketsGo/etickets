import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@eticketsgo/validation';
import { Screen } from '@/components/screen';
import { useAuth } from '@/hooks/use-auth';

/**
 * Minimal, functional login proving the whole foundation end-to-end: React Hook Form
 * + the shared Zod `loginSchema` (no duplicated DTO) → auth store → secure store →
 * auth gate redirect. Phase 2 expands this into the full auth journey.
 */
export default function Login() {
  const { login } = useAuth();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = async (values: LoginInput) => {
    setServerError(null);
    try {
      await login(values); // success → the root gate redirects into the app
    } catch {
      setServerError('Invalid email or password.');
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 justify-center gap-5"
      >
        <View className="gap-1">
          <Text className="text-2xl font-bold text-text-primary">Welcome back</Text>
          <Text className="text-text-muted">Sign in to continue.</Text>
        </View>

        <Field label="Email" error={errors.email?.message}>
          <Controller
            control={control}
            name="email"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                accessibilityLabel="Email"
                autoCapitalize="none"
                keyboardType="email-address"
                textContentType="emailAddress"
                placeholder="you@example.com"
                placeholderTextColor="#838A97"
                value={value}
                onBlur={onBlur}
                onChangeText={onChange}
                className="rounded-md border border-border bg-background-surface px-4 py-3 text-text-primary"
              />
            )}
          />
        </Field>

        <Field label="Password" error={errors.password?.message}>
          <Controller
            control={control}
            name="password"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                accessibilityLabel="Password"
                secureTextEntry
                textContentType="password"
                placeholder="••••••••"
                placeholderTextColor="#838A97"
                value={value}
                onBlur={onBlur}
                onChangeText={onChange}
                className="rounded-md border border-border bg-background-surface px-4 py-3 text-text-primary"
              />
            )}
          />
        </Field>

        {serverError ? (
          <Text accessibilityRole="alert" className="text-status-error">
            {serverError}
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign in"
          disabled={isSubmitting}
          onPress={handleSubmit(onSubmit)}
          className="mt-2 items-center rounded-md bg-action-primary py-4 active:opacity-80"
        >
          {isSubmitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text className="text-base font-semibold text-action-primary-foreground">Sign in</Text>
          )}
        </Pressable>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-text-secondary">{label}</Text>
      {children}
      {error ? <Text className="text-xs text-status-error">{error}</Text> : null}
    </View>
  );
}
