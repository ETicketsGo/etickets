'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Phone } from 'lucide-react';
import type { AuthTokens, MfaChallengeResponse } from '@eticketsgo/shared-types';
import { api, ApiRequestError, errorMessage } from './api';
import { Button, Input, Select } from './components';
import { visitorCountry } from './locale';
import { PHONE_COUNTRIES, isPhoneCountry, readTypedNumber, toE164 } from './phone-number';

/**
 * Sign in with a mobile number and a code, for the operator consoles.
 *
 * ── WHY THE ORGANIZER CONSOLE NEEDS IT ─────────────────────────────────────────────
 * Most accounts on this platform are made with a phone number and a code, and a phone-only
 * account has no email and no password. A customer like that can become an organizer on the
 * storefront - and the console's sign-in then offered only email and password, so they could
 * never get in. This is the storefront's phone sign-in, in the console's components.
 *
 * ── THE SAME DOOR, NOT A NEW ONE ───────────────────────────────────────────────────
 * The same two routes the storefront uses (`/auth/phone/request-code`, `/auth/phone/verify`):
 * the same human check (the API asks for it; `HumanCheckProvider` answers), the same per-number
 * and per-client limits, the same generic answers. The one difference is that a back-office
 * account's second-factor challenge is handed to the caller to complete, exactly as the password
 * form does - never turned into tokens and never refused into a dead end.
 *
 * The country is asked for, opening on the browser's own guess, never a hard-coded +91 or +1:
 * a guessed country is how a code was once sent to a stranger.
 */
export function PhoneCodeSignIn({
  onTokens,
  onChallenge,
  smsCountries,
  onUseEmail,
}: {
  onTokens: (tokens: AuthTokens) => Promise<void> | void;
  onChallenge: (challenge: MfaChallengeResponse) => void;
  /** Countries a code can reach (GET /capabilities); undefined when the API did not say. */
  smsCountries?: string[];
  onUseEmail?: () => void;
}) {
  const [country, setCountry] = useState('');
  const [national, setNational] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);

  // The browser's own guess, after hydration (the zone does not exist on the server).
  useEffect(() => {
    const guess = visitorCountry()?.toUpperCase();
    if (isPhoneCountry(guess)) setCountry((current) => current || guess);
  }, []);

  const e164 = toE164(country, national);
  const market = PHONE_COUNTRIES.find((c) => c.code === country) ?? null;
  const blocked =
    smsCountries !== undefined &&
    (smsCountries.length === 0 || (market !== null && !smsCountries.includes(market.code)));

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.auth.requestPhoneCode(e164);
      setSentTo(e164);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'SMS_UNAVAILABLE') setUnavailable(true);
      else setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sentTo) return;
    setError(null);
    setLoading(true);
    try {
      const result = await api.auth.verifyPhoneCodeOrChallenge(sentTo, code);
      if ('mfaRequired' in result) {
        setLoading(false);
        onChallenge(result);
        return;
      }
      await onTokens(result);
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  };

  if (blocked || unavailable) {
    return (
      <div role="status" data-testid="console-phone-unavailable" className="space-y-3">
        <p className="text-[0.9375rem] text-text-primary">
          {blocked && market && smsCountries && smsCountries.length > 0
            ? `We can't send sign-in codes to ${market.name} yet.`
            : "We can't send sign-in codes by text message right now."}
        </p>
        <p className="text-caption text-text-muted">
          Sign in with your email address instead, or open the console from your ETicketsGo account.
        </p>
        {onUseEmail && (
          <Button type="button" variant="secondary" className="w-full" onClick={onUseEmail}>
            Use email instead
          </Button>
        )}
        {blocked && (
          <button
            type="button"
            className="text-caption text-text-muted underline"
            onClick={() => {
              setCountry('');
              setUnavailable(false);
            }}
          >
            Choose a different country
          </button>
        )}
      </div>
    );
  }

  if (!sentTo) {
    return (
      <form className="space-y-4" onSubmit={send} data-testid="console-phone-form">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
          <Select
            id="phone-country"
            label="Country"
            value={country}
            onChange={(e) => {
              setCountry(e.target.value);
              setUnavailable(false);
              setError(null);
            }}
            required
          >
            <option value="">Choose</option>
            {PHONE_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} +{c.callingCode}
              </option>
            ))}
          </Select>
          <Input
            id="phone"
            label="Mobile number"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            icon={Phone}
            value={national}
            onChange={(e) => {
              const read = readTypedNumber(e.target.value, country);
              if (read.country) setCountry(read.country);
              setNational(read.national);
              setError(null);
            }}
            required
          />
        </div>
        <p className="text-caption text-text-muted">
          We will text you a 6-digit code. Use the number you signed up with on ETicketsGo.
        </p>
        {error && (
          <p role="alert" className="text-caption text-status-error">
            {error}
          </p>
        )}
        <Button
          type="submit"
          className="w-full"
          loading={loading}
          disabled={!market || national.length < 6}
        >
          Send code
        </Button>
      </form>
    );
  }

  return (
    <form className="space-y-4" onSubmit={verify} data-testid="console-phone-code-form">
      <p className="text-[0.9375rem] text-text-muted">We sent a code to {sentTo}.</p>
      <Input
        id="phone-code"
        label="Code"
        icon={KeyRound}
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={6}
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        required
      />
      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" loading={loading} disabled={code.length !== 6}>
        Verify and sign in
      </Button>
      <div className="flex justify-between gap-4 text-caption">
        <button
          type="button"
          className="min-h-11 text-text-muted underline"
          onClick={() => {
            setCode('');
            setError(null);
            void send();
          }}
        >
          Send a new code
        </button>
        <button
          type="button"
          className="min-h-11 text-text-muted underline"
          onClick={() => {
            setSentTo(null);
            setCode('');
            setError(null);
          }}
        >
          Change number
        </button>
      </div>
    </form>
  );
}
