import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Button, Card, Chip, Field, Text, haptics } from '@/ui';
import { useAuth } from '@/hooks/use-auth';
import { authRepository } from '@/data/auth-repository';
import { messageForError } from '@/services/errors';
import { deviceLocale } from '@/services/locale';
import { useResolvedLocation } from '@/features/location/api';
import { PHONE_COUNTRIES, phoneCountryGuess, readTypedNumber, toE164 } from './phone-number';

/**
 * Sign in with a mobile number and a texted code, as the storefront's Mobile tab does
 * (apps/customer-web/components/phone-sign-in.tsx). A new number creates the account.
 *
 * Number, then code, on one screen: a navigation between them loses the number on a back
 * swipe. Both ways out of a stuck code are offered (send again, change the number), because
 * a code that never came and a number typed wrong have different fixes.
 *
 * The send is guarded by the API's human check. The app answers it with Google Play Integrity
 * (services/human-check.ts) inside the API client, so nothing here knows about it; a phone
 * Play does not vouch for gets a plain sentence, never a bypass.
 *
 * NEVER A DEAD FORM: when no code can reach the chosen country (the capabilities say so in
 * advance; a 503 SMS_UNAVAILABLE says so after the fact) the tab says so and offers email.
 */
export function PhoneSignIn({
  onSignedIn,
  onUseEmail,
}: {
  onSignedIn: () => void;
  onUseEmail: () => void;
}) {
  const { loginWithPhone } = useAuth();
  const located = useResolvedLocation();
  const reachable = useQuery({
    queryKey: ['capabilities', 'phoneSignInCountries'],
    queryFn: authRepository.phoneSignInCountries,
    staleTime: 10 * 60_000,
  });

  const [chosenCountry, setChosenCountry] = useState<string | null>(null);
  const country = chosenCountry ?? phoneCountryGuess(located.data?.country, deviceLocale.region);
  const [national, setNational] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);

  const market = PHONE_COUNTRIES.find((c) => c.code === country) ?? null;
  const countries = reachable.data;
  const blocked =
    countries !== undefined &&
    (countries.length === 0 || (market !== null && !countries.includes(market.code)));
  const noSms = blocked || unavailable;
  const e164 = toE164(country, national);

  const sendCode = async () => {
    if (!e164) return;
    setError(null);
    setLoading(true);
    try {
      await authRepository.requestPhoneCode(e164);
      setSentTo(e164);
      setCode('');
    } catch (err) {
      const body = err instanceof AxiosError ? (err.response?.data as { code?: unknown }) : null;
      if (body?.code === 'SMS_UNAVAILABLE') setUnavailable(true);
      else setError(messageForError(err));
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    if (!sentTo || code.length !== 6) return;
    setError(null);
    setLoading(true);
    try {
      await loginWithPhone(sentTo, code);
      haptics.success();
      onSignedIn();
    } catch (err) {
      const refused =
        err instanceof AxiosError && (err.response?.status === 401 || err.response?.status === 400);
      setError(
        refused ? 'That code is not right. Check it, or send a new one.' : messageForError(err),
      );
    } finally {
      setLoading(false);
    }
  };

  if (sentTo) {
    return (
      <View className="gap-5">
        <Text variant="ui" tone="secondary">
          We sent a 6-digit code to {sentTo}.
        </Text>
        <Field
          label="Code"
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          // Lets Android offer the code from the text message, without switching apps.
          autoComplete="sms-otp"
          textContentType="oneTimeCode"
          maxLength={6}
          autoFocus
          returnKeyType="go"
          onSubmitEditing={() => void verify()}
        />
        {error ? <FormError message={error} /> : null}
        <Button
          label="Sign in"
          size="lg"
          loading={loading}
          disabled={code.length !== 6}
          onPress={() => void verify()}
        />
        <View className="flex-row justify-between gap-4">
          <TextLink label="Send a new code" onPress={() => void sendCode()} />
          <TextLink
            label="Change number"
            onPress={() => {
              setSentTo(null);
              setCode('');
              setError(null);
            }}
          />
        </View>
      </View>
    );
  }

  return (
    <View className="gap-5">
      <View className="gap-2">
        <Text variant="ui" className="font-semibold">
          Country
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexShrink: 0 }}
          contentContainerClassName="gap-2"
          keyboardShouldPersistTaps="handled"
        >
          {PHONE_COUNTRIES.map((c) => (
            <Chip
              key={c.code}
              label={`+${c.callingCode} ${c.name}`}
              selected={c.code === country}
              onPress={() => {
                setChosenCountry(c.code);
                setUnavailable(false);
                setError(null);
              }}
            />
          ))}
        </ScrollView>
      </View>

      <Field
        label="Mobile number"
        value={national}
        onChangeText={(typed) => {
          const read = readTypedNumber(typed, country);
          if (read.country) setChosenCountry(read.country);
          setNational(read.national);
          setUnavailable(false);
          setError(null);
        }}
        hint={
          market
            ? `Without +${market.callingCode}. We text you a code.`
            : 'Choose your country first.'
        }
        keyboardType="phone-pad"
        autoComplete="tel"
        textContentType="telephoneNumber"
        editable={!blocked}
        returnKeyType="send"
        onSubmitEditing={() => void sendCode()}
      />

      {noSms ? (
        <Card tone="sunken" className="gap-3">
          <Text variant="ui" className="font-semibold">
            {blocked && market && countries && countries.length > 0
              ? `We cannot text a code to ${market.name} numbers yet.`
              : blocked
                ? 'Sign-in by text message is not available yet.'
                : 'We cannot send text messages right now.'}
          </Text>
          <Text variant="meta" tone="secondary">
            Sign in with your email address instead.
          </Text>
          <Button label="Use email instead" variant="secondary" onPress={onUseEmail} />
        </Card>
      ) : (
        <>
          {error ? <FormError message={error} /> : null}
          <Button
            label="Send code"
            size="lg"
            loading={loading}
            disabled={!market || national.length < 6}
            onPress={() => void sendCode()}
          />
        </>
      )}
    </View>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <Card tone="sunken" className="border-l-4 border-critical">
      <Text variant="ui" tone="danger" accessibilityRole="alert" className="font-medium">
        {message}
      </Text>
    </Card>
  );
}

function TextLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      hitSlop={8}
      style={{ minHeight: 44, justifyContent: 'center' }}
      className="active:opacity-60"
    >
      <View className="border-b border-gold pb-0.5">
        <Text variant="ui" className="font-semibold">
          {label}
        </Text>
      </View>
    </Pressable>
  );
}
