'use client';

import { useId, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Link } from '@/i18n/navigation';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Input } from '@/components/ui';
import { afterSignIn } from '@/lib/sign-in-return';
import { PHONE_COUNTRIES } from '@/lib/phone-number';
import { PhoneNumberField, usePhoneNumber } from '@/components/phone-number-field';
import { useTranslations } from 'next-intl';

/**
 * Signing in - or signing up - with a mobile number and a code.
 *
 * ── WHY THIS IS THE DEFAULT AND EMAIL IS THE ALTERNATIVE ───────────────────────────
 * Every platform an Indian buyer already uses to book a film asks for a phone number. This
 * one asked for an email address and a password — for a purchase that is usually impulsive,
 * often a one-off, and made on a phone with one thumb. Email sign-in has not been removed;
 * it has stopped being the thing somebody meets first.
 *
 * ── ONE COMPONENT FOR SIGN-IN AND SIGN-UP ──────────────────────────────────────────
 * The owner asked for creating an account to work like signing in: the same Mobile | Email
 * tabs, not one long form with everything in it. A code already creates the account when the
 * number is new, so sign-up is sign-in plus the two things an account should start with: a
 * name, and - for a US number only - the text-message agreement the A2P campaign rests on.
 *
 * ── THE TWO STEPS ARE ONE SCREEN ───────────────────────────────────────────────────
 * Number, then code, without a navigation between them. A route change loses the number on
 * a back-swipe and costs a page load on the connection where this matters most.
 *
 * ── NEVER A DEAD FORM ──────────────────────────────────────────────────────────────
 * When a code cannot reach the chosen country (`smsCountries` from GET /capabilities says
 * so in advance; a 503 SMS_UNAVAILABLE says so after the fact) the tab says that plainly and
 * offers the Email tab in one press, carrying the name across. It used to show a red line
 * under a form that could never succeed.
 */
export function PhoneSignIn({
  next,
  signUp = false,
  smsCountries,
  onUseEmail,
}: {
  next: string;
  signUp?: boolean;
  /** Countries a code can reach; undefined when the API did not say (keep trying). */
  smsCountries?: string[];
  /** Switch the page to its Email tab, carrying over the name typed here. */
  onUseEmail?: (fullName: string) => void;
}) {
  const a = useTranslations('storefront.auth');
  const router = useRouter();
  /*
    The country is asked for, never assumed. It used to be a `+91` printed in the field as a
    placeholder while the server put `+91` in front of any ten-digit number — so a visitor in
    the United States typing their own number was sent to a stranger in India, who got their
    sign-in code. It now opens on where the visitor is (see `usePhoneNumber`) and stays a
    choice.
  */
  const phone = usePhoneNumber();
  const [fullName, setFullName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [smsConsent, setSmsConsent] = useState(false);
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The send was refused because text messages cannot be sent at all right now.
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  /*
    One id per copy of the form - see the note in the register page. The sign-in page keeps the
    plain `phone` / `phone-country` ids it always had.
  */
  const uid = useId();
  const ids = signUp
    ? {
        name: `${uid}name`,
        country: `${uid}phone-country`,
        number: `${uid}phone`,
        consent: `${uid}sms-consent`,
      }
    : { name: 'name', country: 'phone-country', number: 'phone', consent: 'sms-consent' };

  const market = PHONE_COUNTRIES.find((c) => c.code === phone.country) ?? null;
  // Known in advance: this deployment cannot text this country (or anywhere at all).
  const blocked =
    smsCountries !== undefined &&
    (smsCountries.length === 0 || (market !== null && !smsCountries.includes(market.code)));
  const noSms = blocked || unavailable;
  /*
    The agreement is asked only where it applies. A2P 10DLC - the reason this exact wording
    exists - governs messages to US numbers; anywhere else the box would be a question about a
    programme that does not cover the person answering it.
  */
  const askConsent = signUp && phone.country === 'US' && !noSms;
  /*
    ── THE DISCLOSURE IS SHOWN EVEN WHILE TEXTING IS OFF ────────────────────────────────
    A carrier reviewer judges the A2P campaign from this page, and they review BEFORE the
    campaign is approved - which is exactly when the deployment cannot text anybody yet. Hiding
    the disclosure whenever sending is unavailable would hide it from the one person who has to
    read it. So a US number always sees the full text; while texting is off it sits inside the
    "not available yet" panel with the box disabled, and a plain line says sign-up by text
    opens later.
  */
  const showDisabledConsent = signUp && phone.country === 'US' && noSms;

  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (signUp && fullName.trim().length < 2) {
      setNameError(a('nameRequired'));
      return;
    }
    setLoading(true);
    try {
      await api.requestPhoneCode(phone.e164);
      setSentTo(phone.e164);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'SMS_UNAVAILABLE') {
        // Said by the panel below, with the way out - not as a red line under a dead form.
        setUnavailable(true);
      } else {
        setError(err instanceof ApiRequestError ? err.message : a('loginFailed'));
      }
    } finally {
      setLoading(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tokens = await api.verifyPhoneCode(
        sentTo!,
        code,
        signUp
          ? {
              fullName: fullName.trim(),
              // Only an affirmative tick is sent; an unticked box sends nothing at all.
              ...(askConsent && smsConsent ? { smsConsent: true as const, country: 'US' } : {}),
            }
          : undefined,
      );
      tokenStore.set(tokens);
      /*
        Sign-in asks for nothing more: a brand-new account goes on where it was going, and the
        name is asked for at checkout, where it is needed. Sign-up has already asked.
      */
      // Checked again here, so the component is safe whoever renders it.
      router.push(afterSignIn(next));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : a('codeFailed'));
    } finally {
      setLoading(false);
    }
  };

  if (!sentTo) {
    return (
      <form className="space-y-4" onSubmit={sendCode} noValidate={noSms}>
        {signUp && (
          <Input
            id={ids.name}
            label={a('fullName')}
            autoComplete="name"
            autoFocus
            value={fullName}
            onChange={(e) => {
              setFullName(e.target.value);
              if (nameError) setNameError(null);
            }}
            error={nameError ?? undefined}
            required
          />
        )}
        <PhoneNumberField
          phone={phone}
          ids={{ country: ids.country, number: ids.number }}
          label={a('phoneLabel')}
          countryLabel={a('countryLabel')}
          countryPlaceholder={a('countryPlaceholder')}
          autoFocus={!signUp}
          required={!noSms}
          // Known in advance that no code can go: the country stays changeable, the number box
          // does not invite typing into a form that cannot be sent.
          countryOnly={blocked}
          onEdit={() => {
            // A different country may be one we can text; let them try again.
            setUnavailable(false);
            setError(null);
          }}
        />

        {noSms ? (
          <div
            role="status"
            data-testid="phone-sms-unavailable"
            className="space-y-3 rounded-md border border-border bg-background-subtle p-4"
          >
            <p className="text-[0.9375rem] font-medium text-text-primary">
              {blocked && market && smsCountries && smsCountries.length > 0
                ? a('smsUnavailableFor', { country: market.name })
                : blocked
                  ? // Known in advance and everywhere: not a hiccup, so not "just now".
                    a('smsNotAvailableYet')
                  : a('smsUnavailableNow')}
            </p>
            <p className="text-caption text-text-secondary">
              {signUp ? a('smsUseEmailSignUp') : a('smsUseEmailSignIn')}
            </p>
            {showDisabledConsent && (
              <>
                <p className="text-caption text-text-secondary" data-testid="sms-opens-later">
                  {a('smsSignUpOpensLater')}
                </p>
                <SmsConsentDisclosure id={ids.consent} checked={false} disabled />
              </>
            )}
            {onUseEmail && (
              <Button type="button" className="w-full" onClick={() => onUseEmail(fullName)}>
                {a('useEmailInstead')}
              </Button>
            )}
          </div>
        ) : (
          <>
            <p className="text-caption text-text-muted">
              {signUp ? a('signUpPhoneHint') : a('phoneHint')}
            </p>

            {askConsent && (
              /*
                OPTIONAL, OFF BY DEFAULT, AND ITS OWN QUESTION.

                Separate from accepting the terms and from any marketing. The disclosure sits
                with the control rather than in a policy page, because somebody deciding has to
                be able to read what they are agreeing to without leaving the form. The wording
                is the A2P campaign's opt-in evidence and is kept word for word.
              */
              <SmsConsentDisclosure
                id={ids.consent}
                checked={smsConsent}
                onChange={setSmsConsent}
              />
            )}

            {error && (
              <p role="alert" className="text-caption text-status-error">
                {error}
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              loading={loading}
              disabled={!market || phone.national.length < 6}
            >
              {a('sendCode')}
            </Button>
          </>
        )}
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
        {signUp ? a('createAccount') : a('verifyAndSignIn')}
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
            void sendCode();
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

/**
 * The US text-message agreement, word for word as submitted with the A2P campaign.
 *
 * One component so the live box and the disabled one shown while texting is off can never
 * drift apart in wording - the reviewer must read the same sentences either way.
 */
function SmsConsentDisclosure({
  id,
  checked,
  onChange,
  disabled = false,
}: {
  id: string;
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-background-surface p-4">
      <label className={`flex items-start gap-3 ${disabled ? '' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          id={id}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 rounded border-border-input text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed"
        />
        <span className="text-[0.875rem] leading-relaxed text-text-secondary">
          Send me transactional text messages from ETicketsGo about my bookings, tickets, event
          updates, cancellations, refunds, and account or service notifications. Message frequency
          varies. Message and data rates may apply. Reply{' '}
          <strong className="font-semibold text-text-primary">STOP</strong> to opt out or{' '}
          <strong className="font-semibold text-text-primary">HELP</strong> for help. Consent is not
          a condition of purchase.
        </span>
      </label>
      <p className="text-[0.875rem] text-text-secondary">
        See our{' '}
        <Link href="/terms" className="font-medium text-action-primary hover:underline">
          Terms &amp; Conditions
        </Link>{' '}
        and{' '}
        <Link href="/privacy" className="font-medium text-action-primary hover:underline">
          Privacy Policy
        </Link>
        .
      </p>
    </div>
  );
}
