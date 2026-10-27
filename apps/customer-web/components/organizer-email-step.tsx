'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ApiRequestError, api as wk, tokenStore } from '@eticketsgo/web-kit';
import {
  BRAND_ALERT,
  BRAND_INSET,
  BRAND_NOTE,
  BrandActionButton,
  BrandInput,
} from '@/components/brand-forms';
import { BRAND_LINK } from '@/components/booking-brand';

/**
 * An email address for organizer messages, for an account that has only a mobile number.
 *
 * Everything the platform tells an organizer - approved, rejected, a payout, a dispute - goes to
 * the owner's account email, and a phone-only account has none, so those messages went nowhere.
 * Asked once the organization exists, PROVED by a 6-digit code sent to the address (the API's
 * email-verification.service.ts), and never a password. Skippable: an organization is never held
 * hostage to an inbox, and the profile offers the same step later.
 */
/**
 * `organizer`: on the become-organizer page, where it can be skipped and the address is for
 * organizer messages. `account`: on the profile, for ANY phone-only account (an address for
 * receipts and account messages); nothing to skip there.
 */
export function OrganizerEmailStep({
  purpose = 'organizer',
}: { purpose?: 'organizer' | 'account' } = {}) {
  const t = useTranslations('storefront.becomeOrganizer');
  const k = (key: 'emailTitle' | 'emailLead' | 'emailDone') =>
    purpose === 'account' ? (`account${key[0].toUpperCase()}${key.slice(1)}` as const) : key;
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : t('emailFailed'));

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await wk.auth.requestEmailCode(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sentTo) return;
    setError(null);
    setLoading(true);
    try {
      const { email: saved } = await wk.auth.verifyEmailCode(sentTo, code);
      // The token still names the account as it was; a rotation carries the new address.
      const refresh = tokenStore.refresh;
      if (refresh) {
        try {
          tokenStore.set(await wk.auth.refresh(refresh));
        } catch {
          // The address is saved either way; the next refresh picks it up.
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      setDone(saved);
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <p
        role="status"
        data-testid="organizer-email-done"
        className={`${BRAND_INSET} text-brand-ui`}
      >
        {t(k('emailDone'), { email: done })}
      </p>
    );
  }
  if (skipped) {
    return <p className={BRAND_NOTE}>{t('emailLater')}</p>;
  }

  return (
    <section
      aria-labelledby="organizer-email-title"
      data-testid="organizer-email-step"
      className={`space-y-3 ${BRAND_INSET}`}
    >
      <h2 id="organizer-email-title" className="text-brand-ui font-semibold text-brand-ink">
        {t(k('emailTitle'))}
      </h2>
      <p className="text-brand-meta text-brand-ink-2">{t(k('emailLead'))}</p>
      {!sentTo ? (
        <form className="space-y-3" onSubmit={send}>
          <BrandInput
            id="organizer-email"
            label={t('emailLabel')}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {error && (
            <p role="alert" className={BRAND_ALERT}>
              {error}
            </p>
          )}
          <BrandActionButton
            type="submit"
            className="w-full"
            loading={loading}
            disabled={!/^\S+@\S+\.\S+$/.test(email.trim())}
          >
            {t('emailSend')}
          </BrandActionButton>
        </form>
      ) : (
        <form className="space-y-3" onSubmit={confirm}>
          <p className="text-brand-meta text-brand-ink-2">
            {t('emailCodeSent', { email: sentTo })}
          </p>
          <BrandInput
            id="organizer-email-code"
            label={t('emailCodeLabel')}
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
          />
          {error && (
            <p role="alert" className={BRAND_ALERT}>
              {error}
            </p>
          )}
          <BrandActionButton
            type="submit"
            className="w-full"
            loading={loading}
            disabled={code.length !== 6}
          >
            {t('emailConfirm')}
          </BrandActionButton>
          <div className="flex justify-between gap-4 text-brand-meta">
            <button
              type="button"
              className={`min-h-11 ${BRAND_LINK}`}
              onClick={() => {
                setCode('');
                void send();
              }}
            >
              {t('emailResend')}
            </button>
            <button
              type="button"
              className={`min-h-11 ${BRAND_LINK}`}
              onClick={() => {
                setSentTo(null);
                setCode('');
                setError(null);
              }}
            >
              {t('emailChange')}
            </button>
          </div>
        </form>
      )}
      {purpose === 'organizer' && (
        <button
          type="button"
          data-testid="organizer-email-skip"
          className={`min-h-11 text-brand-meta ${BRAND_LINK}`}
          onClick={() => setSkipped(true)}
        >
          {t('emailSkip')}
        </button>
      )}
    </section>
  );
}
