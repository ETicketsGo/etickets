'use client';

import { useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Input, Select } from '@/components/ui';
import { safeNextPath, visitorCountry } from '@eticketsgo/web-kit';
import { MARKETS } from '@eticketsgo/shared-types';
import { useTranslations } from 'next-intl';

/** The countries we sell in, in the order a person scans a list: by name. */
const COUNTRIES = [...MARKETS].sort((a, b) => a.name.localeCompare(b.name));

/** Longest calling code first, so a pasted +971 number is not read as +9. */
const BY_LONGEST_CODE = [...COUNTRIES].sort((a, b) => b.callingCode.length - a.callingCode.length);

/** The domestic trunk `0` is not part of the number once a country code is in front of it. */
const withoutTrunkZero = (digits: string) => digits.replace(/^0+/, '');

/**
 * Signing in with a mobile number and a code.
 *
 * ── WHY THIS IS THE DEFAULT AND EMAIL IS THE ALTERNATIVE ───────────────────────────
 * Every platform an Indian buyer already uses to book a film asks for a phone number. This
 * one asked for an email address and a password — for a purchase that is usually impulsive,
 * often a one-off, and made on a phone with one thumb. Email sign-in has not been removed;
 * it has stopped being the thing somebody meets first.
 *
 * ── THE TWO STEPS ARE ONE SCREEN ───────────────────────────────────────────────────
 * Number, then code, without a navigation between them. A route change loses the number on
 * a back-swipe and costs a page load on the connection where this matters most.
 */
export function PhoneSignIn({ next }: { next: string }) {
  const a = useTranslations('storefront.auth');
  const router = useRouter();
  /*
    The country is asked for, never assumed. It used to be a `+91` printed in the field as a
    placeholder while the server put `+91` in front of any ten-digit number — so a visitor in
    the United States typing their own number was sent to a stranger in India, who got their
    sign-in code. The country is now part of the number the client builds.
  */
  const [country, setCountry] = useState('');
  const [national, setNational] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /*
    Set after hydration, not during render: the browser's time zone and languages do not exist
    on the server, and a first render that disagrees with the server's is a hydration error.
    An unrecognised country leaves the select empty and the person chooses — which is the
    honest outcome for somebody we cannot place.
  */
  useEffect(() => {
    const guess = visitorCountry();
    if (guess && COUNTRIES.some((c) => c.code === guess)) setCountry(guess);
  }, []);

  const market = COUNTRIES.find((c) => c.code === country) ?? null;
  const e164 = market ? `+${market.callingCode}${national}` : '';

  /** Accepts a pasted international number by reading the country out of it. */
  const onNationalChange = (typed: string) => {
    const trimmed = typed.trim();
    if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
      const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
      const pasted = BY_LONGEST_CODE.find((c) => digits.startsWith(c.callingCode));
      if (pasted) {
        setCountry(pasted.code);
        setNational(withoutTrunkZero(digits.slice(pasted.callingCode.length)));
        return;
      }
    }
    setNational(withoutTrunkZero(typed.replace(/\D/g, '')));
  };

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.requestPhoneCode(e164);
      setSentTo(e164);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : a('loginFailed'));
    } finally {
      setLoading(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tokens = await api.verifyPhoneCode(sentTo!, code);
      tokenStore.set(tokens);
      /*
        A brand-new account has no name yet — the person gave a number and nothing else. They
        are sent to their account rather than interrogated at the door; the name is asked for
        at checkout, where it is actually needed and where they are already typing.
      */
      // Checked again here, so the component is safe whoever renders it.
      router.push(safeNextPath(next, '/account/tickets'));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : a('codeFailed'));
    } finally {
      setLoading(false);
    }
  };

  if (!sentTo) {
    return (
      <form className="space-y-4" onSubmit={sendCode}>
        {/*
          One column on a phone, two where there is room. The column widths are explicit: an
          implicit grid track sizes to its widest child, which a country name is.
        */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
          <Select
            id="phone-country"
            label={a('countryLabel')}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            required
          >
            <option value="">{a('countryPlaceholder')}</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} +{c.callingCode}
              </option>
            ))}
          </Select>
          <Input
            id="phone"
            label={a('phoneLabel')}
            type="tel"
            inputMode="tel"
            // The national part only: the country is the field beside it.
            autoComplete="tel-national"
            autoFocus
            value={national}
            onChange={(e) => onNationalChange(e.target.value)}
            required
          />
        </div>
        <p className="text-caption text-text-muted">{a('phoneHint')}</p>
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
          {a('sendCode')}
        </Button>
      </form>
    );
  }

  return (
    <form className="space-y-4" onSubmit={verify}>
      <p className="text-[0.9375rem] text-text-secondary">{a('codeSentTo', { phone: sentTo })}</p>
      <Input
        id="code"
        label={a('codeLabel')}
        // `one-time-code` lets iOS and Android offer the code straight from the SMS, which
        // removes the app-switch this flow otherwise forces on every single sign-in.
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
        {a('verifyAndSignIn')}
      </Button>
      {/*
        Both ways out of a stuck state. A code that never arrived and a number typed wrong are
        different problems with different fixes, and somebody staring at an empty inbox should
        not have to guess which one they have.
      */}
      <div className="flex justify-between text-caption">
        <button
          type="button"
          onClick={() => {
            setCode('');
            setError(null);
            void sendCode(new Event('submit') as unknown as React.FormEvent);
          }}
          className="text-action-primary underline-offset-2 hover:underline"
        >
          {a('resendCode')}
        </button>
        <button
          type="button"
          onClick={() => {
            setSentTo(null);
            setCode('');
            setError(null);
          }}
          className="text-text-muted underline-offset-2 hover:underline"
        >
          {a('changeNumber')}
        </button>
      </div>
    </form>
  );
}
