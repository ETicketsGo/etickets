'use client';

import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { Suspense, useEffect, useState } from 'react';
import { signInModes, useSmsCapability, type SignInMode } from '@/lib/sign-in-modes';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import {
  BRAND_ALERT,
  BRAND_NOTE,
  BRAND_PAGE_TITLE,
  BrandActionButton,
  BrandCenteredPage,
  BrandFormPanel,
  BrandInput,
  BrandTabs,
  BrandTabsPlaceholder,
} from '@/components/brand-forms';
import { BRAND_LINK } from '@/components/booking-brand';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { PhoneSignIn } from '@/components/phone-sign-in';
import { adminConsoleOrigin, afterSignIn } from '@/lib/sign-in-return';

function LoginForm() {
  const a = useTranslations('storefront.auth');
  // Guest copy, for the way in that does not involve an account at all.
  const g = useTranslations('storefront.guest');
  const router = useRouter();
  const params = useSearchParams();
  // Only a path on this site: an unchecked `next` made sign-in a redirect to any host. With no
  // usable `next`, the home page - not "My tickets" (see lib/sign-in-return).
  const next = afterSignIn(params.get('next'));
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
  const { loaded: capsLoaded, phoneSignIn, smsCountries } = useSmsCapability();
  const [chosen, setChosen] = useState<SignInMode | null>(null);
  const { modes, initial } = signInModes(phoneSignIn, Boolean(params.get('email')), smsCountries);
  const mode = chosen && modes.includes(chosen) ? chosen : initial;
  const [email, setEmail] = useState(() => params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Set when the account is a back-office one, which signs in at the admin console instead.
  const [backOffice, setBackOffice] = useState(false);
  const [adminOrigin, setAdminOrigin] = useState<string | null>(null);
  useEffect(() => setAdminOrigin(adminConsoleOrigin(window.location)), []);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBackOffice(false);
    setLoading(true);
    try {
      const tokens = await api.login({ email, password });
      tokenStore.set(tokens);
      router.push(next);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'MFA_REQUIRED') {
        // The password was right; this account works in the admin console, not here.
        setBackOffice(true);
        return;
      }
      setError(err instanceof ApiRequestError ? err.message : a('loginFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <BrandCenteredPage>
      <BrandFormPanel className="space-y-5">
        <h1 className={BRAND_PAGE_TITLE}>{a('signIn')}</h1>

        {!capsLoaded ? (
          <BrandTabsPlaceholder />
        ) : modes.length === 1 ? (
          <p className={BRAND_NOTE} data-testid="phone-signin-off">
            {a('phoneUnavailable')}
          </p>
        ) : (
          <BrandTabs
            tabs={modes.map((m) => ({
              value: m,
              label: m === 'phone' ? a('phoneTab') : a('emailTab'),
            }))}
            value={mode}
            onChange={(m) => {
              setChosen(m);
              setError(null);
            }}
          />
        )}

        {/*
        Room for the form while the sign-in options are fetched. Without it the page was one
        card tall, then grew when they arrived, pushing the footer down the screen (CLS 0.19).
      */}
        {!capsLoaded ? (
          <div className="min-h-60" aria-hidden="true" />
        ) : mode === 'phone' ? (
          <PhoneSignIn
            next={next}
            smsCountries={smsCountries}
            onUseEmail={() => {
              setChosen('email');
              setError(null);
            }}
          />
        ) : (
          <>
            <form className="space-y-4" onSubmit={submit}>
              <BrandInput
                id="email"
                label={a('email')}
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <BrandInput
                id="password"
                label={a('password')}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {error && (
                <p role="alert" className={BRAND_ALERT}>
                  {error}
                </p>
              )}
              {backOffice && (
                <div role="alert" className="space-y-2 text-brand-meta text-brand-ink-2">
                  <p>{a('backOfficeSignIn')}</p>
                  {adminOrigin && (
                    <a
                      href={`${adminOrigin}/login?email=${encodeURIComponent(email)}`}
                      className={BRAND_LINK}
                    >
                      {a('backOfficeOpenConsole')}
                    </a>
                  )}
                </div>
              )}
              <BrandActionButton type="submit" size="lg" className="w-full" loading={loading}>
                {a('signIn')}
              </BrandActionButton>
            </form>
            {/*
        The way back in, and it belongs here rather than only on an error. Somebody who has
        forgotten their password does not first try one and read the failure — they look for
        the link before typing anything.
      */}
            <Link href="/forgot-password" className={`inline-block text-brand-meta ${BRAND_LINK}`}>
              {a('forgotPassword')}
            </Link>
          </>
        )}
        <div className="space-y-2 border-t border-brand-line pt-5">
          <p className={BRAND_NOTE}>
            {a('noAccount')}{' '}
            <Link href={registerHref} className={BRAND_LINK}>
              {a('createOne')}
            </Link>
          </p>
          {/*
        The way in for somebody who never made an account.

        A guest has no password to reset and nothing to sign in to, so every link on this page
        was a dead end for them -- and this is the page they land on when they go looking for a
        ticket they have already bought.
      */}
          <p className={BRAND_NOTE}>
            {g('findFromSignIn')}{' '}
            <Link href="/booking/find" className={BRAND_LINK}>
              {g('findTitle')}
            </Link>
          </p>
        </div>
      </BrandFormPanel>
    </BrandCenteredPage>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
