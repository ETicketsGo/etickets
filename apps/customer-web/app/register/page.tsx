'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Card, Input } from '@/components/ui';

function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  // `?intent=organizer` comes from the "Start selling tickets" calls to action. It changes
  // the copy and where we send people afterwards — not what is created. Registration always
  // creates a normal account; organizer access is granted when an organization is created,
  // which is the step this page previously left people to discover on their own.
  const organizerIntent = params.get('intent') === 'organizer';

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setEmailTaken(false);
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
      router.push('/account/tickets');
    } catch (err) {
      // Match on the CODE, not the message: the copy below is ours to write, and a message
      // comparison would silently stop working if the API reworded its error.
      if (err instanceof ApiRequestError && err.code === 'EMAIL_ALREADY_REGISTERED') {
        setEmailTaken(true);
      } else {
        setError(
          err instanceof ApiRequestError
            ? err.message
            : 'We could not create your account. Check your connection and try again.',
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const signInHref = `/login${email ? `?email=${encodeURIComponent(email)}` : ''}`;

  return (
    <Card className="mx-auto max-w-sm space-y-4">
      <div>
        <h1 className="text-h2 font-bold text-text-primary">
          {organizerIntent ? 'Create your organizer account' : 'Create your account'}
        </h1>
        <p className="mt-1 text-caption text-text-muted">
          {organizerIntent ? (
            <>
              Two steps: create your account here, then set up your organization in the organizer
              console. You can also buy tickets with this same account.
            </>
          ) : (
            <>
              This is a customer account for buying tickets. Running events?{' '}
              <Link href="/register?intent=organizer" className="text-action-primary underline">
                Create an organizer account
              </Link>
              .
            </>
          )}
        </p>
      </div>

      <form className="space-y-4" onSubmit={submit}>
        <Input
          id="name"
          label="Full name"
          autoFocus
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
        />
        <Input
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            // The warning is about the address they had typed; clear it as they edit.
            if (emailTaken) setEmailTaken(false);
          }}
          required
        />
        <Input
          id="password"
          label="Password (min 8 chars)"
          type="password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {emailTaken && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-status-error/30 bg-status-error/5 p-3"
          >
            <p className="text-caption font-medium text-text-primary">
              An account already exists for {email}.
            </p>
            <p className="text-caption text-text-muted">
              Sign in instead, or register with a different email address.
            </p>
            <Link
              href={signInHref}
              className="inline-block text-caption font-medium text-action-primary"
            >
              Sign in as {email} →
            </Link>
          </div>
        )}

        {error && (
          <p role="alert" className="text-caption text-status-error">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" loading={loading}>
          {organizerIntent ? 'Create organizer account' : 'Create account'}
        </Button>
      </form>

      <p className="text-caption text-text-muted">
        Already have an account?{' '}
        <Link href="/login" className="text-action-primary underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}

export default function RegisterPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={<Card className="mx-auto max-w-sm">Loading…</Card>}>
      <RegisterForm />
    </Suspense>
  );
}
