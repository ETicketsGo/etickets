'use client';

import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Card, Input, Select } from '@/components/ui';
import {
  PasswordField,
  passwordAcceptable,
  safeNextPath,
  visitorCountry,
} from '@eticketsgo/web-kit';
import { MARKETS } from '@eticketsgo/shared-types';
import { usePasswordCopy } from '@/lib/use-password-copy';

/** The countries we sell in, in the order a person scans a list: by name. */
const COUNTRIES = [...MARKETS].sort((a, b) => a.name.localeCompare(b.name));
/** Longest calling code first, so a pasted +971 number is not read as +9. */
const BY_LONGEST_CODE = [...COUNTRIES].sort((a, b) => b.callingCode.length - a.callingCode.length);
/** The domestic trunk `0` is not part of the number once a country code is in front of it. */
const withoutTrunkZero = (digits: string) => digits.replace(/^0+/, '');
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

function RegisterForm() {
  const a = useTranslations('storefront.auth');
  const router = useRouter();
  const params = useSearchParams();
  // `?intent=organizer` comes from the "Start selling tickets" calls to action. It changes
  // the copy and where we send people afterwards — not what is created. Registration always
  // creates a normal account; organizer access is granted when an organization is created,
  // which is the step this page previously left people to discover on their own.
  const organizerIntent = params.get('intent') === 'organizer';
  /*
    Where the buyer was going when sign-in sent them here to make an account.

    Sign-up used to end at the tickets page whatever the reason for signing up, so somebody
    who hit "Continue to payment" signed out, made an account, and was left to find the event
    again. Validated exactly as sign-in validates it: only a path on this site.
  */
  const hasNext = Boolean(params.get('next'));
  const next = safeNextPath(params.get('next'), '/account/tickets');

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [phoneCountry, setPhoneCountry] = useState('');
  const [phoneNational, setPhoneNational] = useState('');
  const [smsConsent, setSmsConsent] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const passwordCopy = usePasswordCopy();

  /*
    After hydration, never during render: the browser's time zone does not exist on the
    server and a first render that disagrees with the server's is a hydration error. An
    unrecognised country leaves the select empty and the person chooses, which is the honest
    outcome for somebody we cannot place.
  */
  useEffect(() => {
    const guess = visitorCountry();
    if (guess && COUNTRIES.some((c) => c.code === guess)) setPhoneCountry(guess);
  }, []);

  const phoneMarket = COUNTRIES.find((c) => c.code === phoneCountry) ?? null;
  const phoneE164 =
    phoneMarket && phoneNational ? `+${phoneMarket.callingCode}${phoneNational}` : '';

  /** Accepts a pasted international number by reading the country out of it. */
  const onPhoneChange = (typed: string) => {
    if (phoneError) setPhoneError(null);
    const trimmed = typed.trim();
    if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
      const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
      const pasted = BY_LONGEST_CODE.find((c) => digits.startsWith(c.callingCode));
      if (pasted) {
        setPhoneCountry(pasted.code);
        setPhoneNational(withoutTrunkZero(digits.slice(pasted.callingCode.length)));
        return;
      }
    }
    setPhoneNational(withoutTrunkZero(typed.replace(/\D/g, '')));
  };
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setEmailTaken(false);
    setPasswordError(null);
    setPhoneError(null);

    /*
      Consent needs something to consent ABOUT, and the complaint belongs on the EMPTY FIELD.
      Pointing at the checkbox would tell somebody to undo the thing they just chose; pointing
      at the number tells them what to fill in. The same rule is enforced in `registerSchema`,
      so a client that skips this still cannot create a consent with nothing to send to.
    */
    if (smsConsent && !phoneE164) {
      setPhoneError('Add your mobile number so we can text you, or clear the text message box.');
      return;
    }

    setLoading(true);
    try {
      const tokens = await api.register({
        fullName,
        email,
        password,
        // Omitted entirely when absent, so the payload never implies a decision nobody made.
        ...(phoneE164 ? { phone: phoneE164 } : {}),
        ...(smsConsent ? { smsConsent: true, country: phoneCountry || undefined } : {}),
      });
      tokenStore.set(tokens);
      if (organizerIntent) {
        /*
          To the page that can actually set them up — NOT straight to the organizer console.

          The tokens just written live in THIS origin's localStorage. The organizer app is a
          different origin, so it would have seen a signed-out visitor, sent them to its own
          login, and refused the brand-new account for lacking a role that only creating an
          organization grants. Nothing was broken in isolation; the three steps composed into
          a loop with no exit.
        */
        router.push('/account/become-organizer');
        return;
      }
      router.push(next);
    } catch (err) {
      // Match on the CODE, not the message: the copy below is ours to write, and a message
      // comparison would silently stop working if the API reworded its error.
      const fields =
        err instanceof ApiRequestError
          ? (err.details?.fields as Record<string, string[]> | undefined)
          : undefined;
      if (err instanceof ApiRequestError && err.code === 'EMAIL_ALREADY_REGISTERED') {
        setEmailTaken(true);
      } else if (fields?.password?.[0]) {
        // The server's reason, under the field it is about, rather than "the request failed
        // validation" at the bottom of the form.
        setPasswordError(fields.password[0]);
      } else if (fields?.email?.[0]) {
        setError(fields.email[0]);
      } else {
        setError(err instanceof ApiRequestError ? err.message : a('registerFailed'));
      }
    } finally {
      setLoading(false);
    }
  };

  // Both ways back to sign-in keep `next`, so switching forms does not lose the destination.
  const signInQuery = new URLSearchParams();
  if (email) signInQuery.set('email', email);
  if (hasNext) signInQuery.set('next', next);
  const signInQueryString = signInQuery.toString();
  const signInHref = `/login${signInQueryString ? `?${signInQueryString}` : ''}`;
  const plainSignInHref = hasNext ? `/login?next=${encodeURIComponent(next)}` : '/login';

  return (
    <Card className="mx-auto max-w-sm space-y-4">
      <div>
        <h1 className="text-h2 font-bold text-text-primary">
          {organizerIntent ? a('createYourOrganizerAccount') : a('createYourAccount')}
        </h1>
        <p className="mt-1 text-caption text-text-muted">
          {organizerIntent
            ? a('organizerLead')
            : a.rich('customerLead', {
                link: (chunks) => (
                  <Link href="/register?intent=organizer" className="text-action-primary underline">
                    {chunks}
                  </Link>
                ),
              })}
        </p>
      </div>

      <form className="space-y-4" onSubmit={submit}>
        <Input
          id="name"
          label={a('fullName')}
          autoFocus
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
        />
        <Input
          id="email"
          label={a('email')}
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            // The warning is about the address they had typed; clear it as they edit.
            if (emailTaken) setEmailTaken(false);
          }}
          required
        />
        <PasswordField
          id="password"
          value={password}
          onChange={(nextPassword) => {
            setPassword(nextPassword);
            if (passwordError) setPasswordError(null);
          }}
          context={{ email, name: fullName }}
          copy={passwordCopy}
          serverError={passwordError ?? undefined}
          required
        />

        {/*
          OPTIONAL, AND IT STAYS OPTIONAL.

          A mobile number is how we can also text somebody about their booking; it is not a
          condition of having an account or of buying a ticket, and the heading says so rather
          than leaving it to be inferred from a missing asterisk.

          The checkbox is a SEPARATE question from accepting the terms and from any marketing,
          and it starts off. The disclosure sits with the control rather than in a policy page,
          because somebody deciding has to be able to read what they are agreeing to without
          leaving the form.
        */}
        <fieldset className="space-y-3 rounded-lg border border-border bg-background-subtle/40 p-4">
          <legend className="px-1 text-[0.9375rem] font-semibold text-text-primary">
            Mobile number <span className="font-normal text-text-secondary">(optional)</span>
          </legend>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
            <Select
              id="phone-country"
              label="Country"
              value={phoneCountry}
              onChange={(e) => {
                setPhoneCountry(e.target.value);
                if (phoneError) setPhoneError(null);
              }}
            >
              <option value="">Select</option>
              {COUNTRIES.map((c) => (
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
              value={phoneNational}
              onChange={(e) => onPhoneChange(e.target.value)}
              error={phoneError ?? undefined}
            />
          </div>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              id="sms-consent"
              checked={smsConsent}
              onChange={(e) => {
                setSmsConsent(e.target.checked);
                if (phoneError) setPhoneError(null);
              }}
              className="mt-1 h-4 w-4 shrink-0 rounded border-border-input text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            />
            <span className="text-[0.875rem] leading-relaxed text-text-secondary">
              Send me transactional text messages from ETicketsGo about my bookings, tickets, event
              updates, cancellations, refunds, and account or service notifications. Message
              frequency varies. Message and data rates may apply. Reply{' '}
              <strong className="font-semibold text-text-primary">STOP</strong> to opt out or{' '}
              <strong className="font-semibold text-text-primary">HELP</strong> for help. Consent is
              not a condition of purchase.
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
        </fieldset>

        {emailTaken && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-status-error/30 bg-status-error/5 p-3"
          >
            <p className="text-caption font-medium text-text-primary">
              {a('accountExists', { email })}
            </p>
            <p className="text-caption text-text-muted">{a('signInInstead')}</p>
            <Link
              href={signInHref}
              className="inline-block text-caption font-medium text-action-primary"
            >
              {a('signInAs', { email })}
            </Link>
          </div>
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
          disabled={!passwordAcceptable(password, { email, name: fullName })}
        >
          {organizerIntent ? a('createOrganizerAccount') : a('createAccount')}
        </Button>
      </form>

      <p className="text-caption text-text-muted">
        {a('haveAccount')}{' '}
        <Link href={plainSignInHref} className="text-action-primary underline">
          {a('signIn')}
        </Link>
      </p>
    </Card>
  );
}

function RegisterFallback() {
  const a = useTranslations('storefront.auth');
  return <Card className="mx-auto max-w-sm">{a('loading')}</Card>;
}

export default function RegisterPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={<RegisterFallback />}>
      <RegisterForm />
    </Suspense>
  );
}
