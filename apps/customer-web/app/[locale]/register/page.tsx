'use client';

import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { Suspense, useState } from 'react';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Card, Input } from '@/components/ui';
import { PasswordField, passwordAcceptable, safeNextPath } from '@eticketsgo/web-kit';
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
  const next = safeNextPath(params.get('next'), '/account/tickets');

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const passwordCopy = usePasswordCopy();
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setEmailTaken(false);
    setPasswordError(null);
    setLoading(true);
    try {
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
