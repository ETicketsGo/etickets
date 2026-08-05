import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Screen } from '@/components/screen';
import { Button, Card, Field, IconButton, Text } from '@/ui';
import { useAuth } from '@/hooks/use-auth';
import { useOnline } from '@/hooks/use-online';
import { apiClient } from '@/services/api-client';
import { messageForError } from '@/services/errors';
import { env } from '@/services/env';
import Constants from 'expo-constants';

/**
 * Contact support. POSTs to the existing public /support endpoint.
 *
 * The app version and environment are appended to the message body rather than
 * collected as fields, because the first reply to any support ticket is otherwise
 * "which version are you on?" — and the user does not know.
 */
export default function SupportScreen() {
  const router = useRouter();
  const online = useOnline();
  const { user } = useAuth();

  const [email, setEmail] = useState(user?.email ?? '');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async () => {
    const next: Record<string, string> = {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) next.email = 'Enter a valid email.';
    if (subject.trim().length < 3) next.subject = 'Add a short subject.';
    if (message.trim().length < 10) next.message = 'Tell us a little more so we can help.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    try {
      await apiClient.post('/support', {
        email: email.trim(),
        subject: subject.trim(),
        message: `${message.trim()}\n\n---\nETicketsGo mobile ${
          Constants.expoConfig?.version ?? '?'
        } (${env.env}) · ${Platform.OS} ${Platform.Version}`,
      });
      setSent(true);
    } catch (err) {
      setErrors({ form: messageForError(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen padded={false}>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center gap-1 px-2 py-1">
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
        />
        <Text variant="callout" className="flex-1 font-semibold">
          Help &amp; contact
        </Text>
      </View>

      {sent ? (
        <View className="flex-1 justify-center px-5">
          <Card className="gap-2">
            <Text variant="title3">Thanks — we&rsquo;ve got it</Text>
            <Text variant="subhead" tone="muted">
              We&rsquo;ll reply to {email}. Most questions get an answer within a working day.
            </Text>
            <Button label="Done" className="mt-2" onPress={() => router.back()} />
          </Card>
        </View>
      ) : (
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerClassName="gap-4 px-5 pb-8 pt-2"
            keyboardShouldPersistTaps="handled"
          >
            <Text variant="subhead" tone="muted">
              Trouble with a booking, a ticket that won&rsquo;t scan, or a refund — tell us what
              happened and we&rsquo;ll pick it up.
            </Text>

            <Field
              label="Your email"
              value={email}
              onChangeText={setEmail}
              error={errors.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              editable={!submitting}
            />
            <Field
              label="Subject"
              value={subject}
              onChangeText={setSubject}
              error={errors.subject}
              editable={!submitting}
            />
            <Field
              label="What happened?"
              value={message}
              onChangeText={setMessage}
              error={errors.message}
              multiline
              minHeight={140}
              editable={!submitting}
            />

            {errors.form ? (
              <Text variant="subhead" tone="danger" accessibilityRole="alert">
                {errors.form}
              </Text>
            ) : null}

            <Button
              label="Send"
              size="lg"
              loading={submitting}
              disabled={!online}
              onPress={() => void onSubmit()}
            />
            {!online ? (
              <Text variant="footnote" tone="muted" className="text-center">
                You need a connection to send this.
              </Text>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </Screen>
  );
}
