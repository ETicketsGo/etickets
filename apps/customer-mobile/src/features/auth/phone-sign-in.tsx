import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Button, Card, Chip, Field, Text, haptics } from '@/ui';
import { useAuth } from '@/hooks/use-auth';
import { authRepository } from '@/data/auth-repository';
import { messageForError } from '@/services/errors';
import { deviceLocale } from '@/services/locale';
import { useResolvedLocation } from '@/features/location/api';
import { phoneSignInOutcome } from '@eticketsgo/shared-types';
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
 *
 * SIGN-UP (`signUp`): the same two steps plus a name. The form cannot know in advance whether
 * the number already has an account (asking would let anybody test who is registered), so the
 * answer comes with the verified code: `isNewAccount: false` means the person was signed into
 * the account they already had - nothing from this form was applied to it - and the screen
 * says so and waits for them to continue. It used to go on exactly as for a new account
 * (owner report, 2026-10-25).
 */
export function PhoneSignIn({
  onSignedIn,
  onUseEmail,
  signUp = false,
}: {
  onSignedIn: () => void;
  onUseEmail: () => void;
  signUp?: boolean;
}) {
  const { loginWithPhone } = useAuth();
  const located = useResolvedLocation();
  const reachable = useQuery({
    queryKey: ['capabilities', 'phoneSignInCountries'],
    queryFn: authRepository.phoneSignInCountries,
    staleTime: 10 * 60_000,
  });

  const [chosenCountry, setChosenCountry] = useState<string | null>(null);
  const guess = phoneCountryGuess(located.data?.country, deviceLocale.region);
  const country = chosenCountry ?? guess;
  /*
    The guessed country leads the row. Alphabetical put the United States last, off the right
    edge of a phone, so the field said +1 while no chip showed which +1 country was chosen
    (seen on an Android 14 emulator). Ordered by the guess, not the choice, so a tap never
    makes the row jump.
  */
  const ordered = useMemo(
    () =>
      guess
        ? [
            ...PHONE_COUNTRIES.filter((c) => c.code === guess),
            ...PHONE_COUNTRIES.filter((c) => c.code !== guess),
          ]
        : PHONE_COUNTRIES,
    [guess],
  );
  const [national, setNational] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fullName, setFullName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  // The code was right and the number already had an account: signed into THAT one.
  const [signedIntoExisting, setSignedIntoExisting] = useState(false);

  const market = PHONE_COUNTRIES.find((c) => c.code === country) ?? null;
  const countries = reachable.data;
  const blocked =
    countries !== undefined &&
    (countries.length === 0 || (market !== null && !countries.includes(market.code)));
  const noSms = blocked || unavailable;
  const e164 = toE164(country, national);

  const sendCode = async () => {
    if (!e164) return;
    if (signUp && fullName.trim().length < 2) {
      setNameError('Please enter your name.');
      return;
    }
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
      const { isNewAccount } = await loginWithPhone(
        sentTo,
        code,
        signUp ? { fullName: fullName.trim() } : undefined,
      );
      haptics.success();
      if (phoneSignInOutcome(signUp ? 'sign-up' : 'sign-in', isNewAccount) === 'existing') {
        setSignedIntoExisting(true);
        return;
      }
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

  if (signedIntoExisting) {
    return (
      <Card tone="sunken" className="gap-4">
        <Text variant="ui" accessibilityRole="alert" className="font-semibold">
          You already have an account with this number. We signed you in.
        </Text>
        <Button label="Continue" size="lg" onPress={onSignedIn} />
      </Card>
    );
  }

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
          label={signUp ? 'Create account' : 'Sign in'}
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
      {signUp ? (
        <Field
          label="Full name"
          value={fullName}
          onChangeText={(v) => {
            setFullName(v);
            if (nameError) setNameError(null);
          }}
          error={nameError ?? undefined}
          autoComplete="name"
          textContentType="name"
        />
      ) : null}
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
          {ordered.map((c) => (
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
