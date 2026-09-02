'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Input } from '@/components/ui';
import { useTranslations } from 'next-intl';

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
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.requestPhoneCode(phone);
      setSentTo(phone);
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
      router.push(next);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : a('codeFailed'));
    } finally {
      setLoading(false);
    }
  };

  if (!sentTo) {
    return (
      <form className="space-y-4" onSubmit={sendCode}>
        <Input
          id="phone"
          label={a('phoneLabel')}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          autoFocus
          placeholder="+91 98765 43210"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />
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
          disabled={phone.trim().length < 6}
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
