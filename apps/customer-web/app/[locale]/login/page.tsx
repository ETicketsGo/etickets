'use client';

import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { Suspense, useEffect, useState } from 'react';
import { signInModes, type SignInMode } from '@/lib/sign-in-modes';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Card, Input } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { PhoneSignIn } from '@/components/phone-sign-in';
import { safeNextPath } from '@eticketsgo/web-kit';

function LoginForm() {
  const a = useTranslations('storefront.auth');
  // Guest copy, for the way in that does not involve an account at all.
  const g = useTranslations('storefront.guest');
  const router = useRouter();
  const params = useSearchParams();
  // Only a path on this site: an unchecked `next` made sign-in a redirect to any host.
  const next = safeNextPath(params.get('next'), '/account/tickets');
  // Carried to sign-up, so creating an account on the way to a purchase ends at the purchase.
  const registerHref = params.get('next')
    ? `/register?next=${encodeURIComponent(next)}`
    : '/register';
  // Prefilled when arriving from the "that email is already registered" path on sign-up, so
  // the address does not have to be typed twice.
  /*
    Phone first, because that is what somebody arriving from a film listing expects — and
    email second rather than gone, because everyone who already has an account has one.

    Defaults to email when the URL prefilled an address: that only happens on the "already
    registered" path from sign-up, where the person has just typed it.
  */
  /*
    Whether text-message sign-in exists is the platform's declaration (GET /capabilities).
    Until it answers we show a neutral placeholder rather than a tab that may vanish; if the
    call fails we fall back to the usual two tabs.
  */
  const [phoneSignIn, setPhoneSignIn] = useState<boolean | undefined>(undefined);
  const [capsLoaded, setCapsLoaded] = useState(false);
  const [chosen, setChosen] = useState<SignInMode | null>(null);
  useEffect(() => {
    let live = true;
    api
      .capabilities()
      .then((c) => live && setPhoneSignIn(c.phoneSignIn))
      .catch(() => undefined)
      .finally(() => live && setCapsLoaded(true));
    return () => {
      live = false;
    };
  }, []);
  const { modes, initial } = signInModes(phoneSignIn, Boolean(params.get('email')));
  const mode = chosen && modes.includes(chosen) ? chosen : initial;
  const [email, setEmail] = useState(() => params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tokens = await api.login({ email, password });
      tokenStore.set(tokens);
      router.push(next);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : a('loginFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="mx-auto max-w-sm space-y-4">
      <h1 className="text-h2 font-bold text-text-primary">{a('signIn')}</h1>

      {!capsLoaded ? (
        <div className="h-10 rounded-md bg-background-subtle" aria-hidden="true" />
      ) : modes.length === 1 ? (
        <p className="text-caption text-text-muted" data-testid="phone-signin-off">
          {a('phoneUnavailable')}
        </p>
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
              className={`flex-1 rounded px-3 py-1.5 text-[0.9375rem] transition-colors ${
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

      {!capsLoaded ? null : mode === 'phone' ? (
        <PhoneSignIn next={next} />
      ) : (
        <>
          <form className="space-y-4" onSubmit={submit}>
            <Input
              id="email"
              label={a('email')}
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Input
              id="password"
              label={a('password')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error && (
              <p role="alert" className="text-caption text-status-error">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" loading={loading}>
              {a('signIn')}
            </Button>
          </form>
          {/*
        The way back in, and it belongs here rather than only on an error. Somebody who has
        forgotten their password does not first try one and read the failure — they look for
        the link before typing anything.
      */}
          <Link href="/forgot-password" className="text-caption text-action-primary underline">
            {a('forgotPassword')}
          </Link>
        </>
      )}
      <p className="text-caption text-text-muted">
        {a('noAccount')}{' '}
        <Link href={registerHref} className="text-action-primary underline">
          {a('createOne')}
        </Link>
      </p>
      {/*
        The way in for somebody who never made an account.

        A guest has no password to reset and nothing to sign in to, so every link on this page
        was a dead end for them -- and this is the page they land on when they go looking for a
        ticket they have already bought.
      */}
      <p className="text-caption text-text-muted">
        {g('findFromSignIn')}{' '}
        <Link href="/booking/find" className="text-action-primary underline">
          {g('findTitle')}
        </Link>
      </p>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
