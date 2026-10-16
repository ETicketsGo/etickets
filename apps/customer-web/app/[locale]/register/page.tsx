'use client';

import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { Suspense, useId, useState } from 'react';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Card, Input } from '@/components/ui';
import { PasswordField, passwordAcceptable } from '@eticketsgo/web-kit';
import { afterSignIn } from '@/lib/sign-in-return';
import { useSmsCapability, type SignInMode } from '@/lib/sign-in-modes';
import { usePhoneCountryGuess } from '@/components/phone-number-field';
import { PhoneSignIn } from '@/components/phone-sign-in';
import { usePasswordCopy } from '@/lib/use-password-copy';
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
  const next = afterSignIn(params.get('next'));

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const passwordCopy = usePasswordCopy();
  /*
    THE SAME TWO WAYS IN AS SIGN-IN.

    This page used to be one long form: name, email, password, then an optional mobile number
    and a text-message box underneath. The owner's words: make creating an account work like
    signing in, Mobile and Email as separate tabs, "instead of everything at one place". So the
    Mobile tab is a number and a code (plus a name), and the Email tab is a name, an address
    and a password - nothing else. The text-message agreement moved to where it applies: the
    Mobile tab, for a US number.

    An organizer account stays email-only. The organizer console signs in with an email and a
    password, so a phone-only organizer would have an account the console cannot open.
  */
  const { loaded: capsLoaded, phoneSignIn, smsCountries } = useSmsCapability();
  const [chosen, setChosen] = useState<SignInMode | null>(null);
  /*
    UNLIKE SIGN-IN, THE MOBILE TAB STAYS EVEN WHEN NO NUMBER CAN BE TEXTED.

    This page is the A2P campaign's opt-in evidence, and the carrier reviews it before the
    campaign is approved - when the deployment can text nobody yet. A US visitor therefore still
    opens on Mobile and reads the full agreement (disabled, with "opens later"), and the Email tab
    is one press away. Anyone else whose number cannot be texted opens on Email, so nobody lands
    on a form that can only send them elsewhere.
  */
  const guess = usePhoneCountryGuess();
  const phoneWorksHere =
    phoneSignIn !== false &&
    (smsCountries === undefined ||
      (guess !== null ? smsCountries.includes(guess) : smsCountries.length > 0));
  const { modes, initial } = organizerIntent
    ? { modes: ['email'] as SignInMode[], initial: 'email' as SignInMode }
    : {
        modes: ['phone', 'email'] as SignInMode[],
        initial: (phoneWorksHere || guess === 'US' ? 'phone' : 'email') as SignInMode,
      };
  const mode = chosen && modes.includes(chosen) ? chosen : initial;
  /*
    ONE ID PER COPY OF THE FORM, NOT ONE PER PAGE.

    This form can exist twice for a moment. The server streams it into a hidden
    `<div hidden id="S:1">` that an inline script later swaps into place; if React has already
    rendered the boundary on the client by then (a parent updated before it hydrated), the
    page briefly holds the client's copy AND the server's. With fixed ids that meant two
    `#sms-consent` checkboxes, and the A2P opt-in test failed on main whenever it looked during
    that window. `useId` gives the server render and a client render different ids, so an id
    always names exactly one control. Each label still wraps its own checkbox, so the
    association never depended on the id.
  */
  const uid = useId();
  const ids = {
    name: `${uid}name`,
    email: `${uid}email`,
    password: `${uid}password`,
  };
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setEmailTaken(false);
    setPasswordError(null);

    setLoading(true);
    try {
      // Name, address, password: the Email tab asks for nothing else (see above).
      const tokens = await api.register({ fullName, email, password });
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

      {organizerIntent ? (
        <p className="text-caption text-text-muted" data-testid="organizer-email-only">
          {a('organizerEmailOnly')}
        </p>
      ) : !capsLoaded ? (
        <div className="h-[3.25rem] rounded-md bg-background-subtle" aria-hidden="true" />
      ) : (
        <div className="flex gap-1 rounded-md bg-background-subtle p-1" role="tablist">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => {
                setChosen(m);
                setError(null);
              }}
              className={`min-h-11 flex-1 rounded px-3 py-1.5 text-[0.9375rem] transition-colors ${
                mode === m
                  ? 'bg-background-surface font-medium text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {m === 'phone' ? a('phoneTab') : a('emailTab')}
            </button>
          ))}
        </div>
      )}

      {/* Room for the form while the options load, as on sign-in (no layout jump). */}
      {!organizerIntent && !capsLoaded ? (
        <div className="min-h-60" aria-hidden="true" />
      ) : mode === 'phone' ? (
        <PhoneSignIn
          signUp
          next={next}
          smsCountries={smsCountries}
          onUseEmail={(typedName) => {
            // The name typed on the Mobile tab is not lost on the way to the Email tab.
            if (typedName && !fullName) setFullName(typedName);
            setChosen('email');
            setError(null);
          }}
        />
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Input
            id={ids.name}
            label={a('fullName')}
            autoFocus={chosen === null}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />
          <Input
            id={ids.email}
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
            id={ids.password}
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
      )}

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
