'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { KeyRound, Lock, Mail } from 'lucide-react';
import type { AuthTokens } from '@eticketsgo/shared-types';
import { api, errorMessage, takeSignedOutNotice, tokenStore } from './api';
import { Button, Card, Input } from './components';
import { nextFromSearch } from './safe-next';
import { Wordmark } from './wordmark';

/** Pages of a console that are a dead end straight after signing in (see `finish`). */
const CONSOLE_SIGN_IN_PAGES = ['/login'] as const;

/** The platform's own staff roles (see `backOfficePath`). */
const BACK_OFFICE_ROLES: readonly string[] = ['ADMIN', 'SUPER_ADMIN'];

/**
 * Reusable email/password sign-in card. Reads an optional `?next=` redirect
 * from the URL at submit time (no Suspense boundary required).
 */
export function LoginForm({
  title = 'Sign in',
  defaultEmail = '',
  defaultRedirect = '/',
  allowedRoles,
  roleMismatchRedirect,
  subtitle,
  mfaEnrollPath,
  backOfficePath,
  footer,
  product,
}: {
  title?: string;
  defaultEmail?: string;
  defaultRedirect?: string;
  allowedRoles?: string[];
  /**
   * Where to send someone who signed in correctly but lacks a role this console needs.
   *
   * Without it the only outcome is "This account cannot access this console" AND the
   * session is thrown away — which is what a brand-new organizer hit. They registered
   * meaning to sell tickets, arrived with the CUSTOMER role every account starts with, and
   * were refused by the one screen that could have set them up. The role is granted by
   * creating an organization, and that page lives behind this door.
   *
   * When set, the credentials were still valid, so the session is KEPT and they are sent
   * somewhere that can fix the gap.
   */
  roleMismatchRedirect?: string;
  subtitle?: string;
  /**
   * Where a back-office account that has not set up its authenticator yet is sent after the
   * password step. Only the admin console passes it; for every other console the server never
   * answers with a second-factor step at all.
   */
  mfaEnrollPath?: string;
  /**
   * Where an account holding a back-office role (ADMIN / SUPER_ADMIN) is sent after signing in,
   * with the destination it would otherwise have had as `?next=`.
   *
   * The organizer console admits those accounts, so an administrator who signed in there landed
   * in whichever organization they happened to belong to - "the other view", in the owner's
   * words, when they meant to reach the admin dashboard. The page this names lets them choose.
   * Only where to go changes; the session and its checks are the same as for anyone else.
   */
  backOfficePath?: string;
  /**
   * Shown under the card: the ways out of a sign-in page a console needs (create an account,
   * forgot your password). The organizer console had none, so a new organizer who arrived there
   * first, or an owner who forgot a password, had nowhere to go.
   */
  footer?: ReactNode;
  /** The console's name, set beside the wordmark above the card: "Organizer", "Admin". */
  product?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(defaultEmail ?? '');
  // Never pre-fill the password — shipping a real credential in a launch build is unsafe.
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Set when the password was right and the account has a second factor to prove.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [mfaCode, setMfaCode] = useState('');

  /*
    Why the last session ended, when it was not the ordinary way: a team removal says "You no
    longer have access to <organization>". Read once after mount, then forgotten, so a later
    visit to this page does not repeat it.
  */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    // Only ever set: a second run of this effect (React's strict mode) finds it already taken.
    const taken = takeSignedOutNotice();
    if (taken) setNotice(taken);
  }, []);

  /*
    `?email=` fills the address. The storefront hands a newly made organizer here with it, and an
    accepted team invitation does the same; ignoring it made them type the address they had just
    given us. Read after mount (not in the initial state) so the server render and the first
    client render agree.
  */
  useEffect(() => {
    if (defaultEmail) return;
    const fromLink = new URLSearchParams(window.location.search).get('email');
    if (fromLink) setEmail((current) => current || fromLink);
  }, [defaultEmail]);

  /** Everything after tokens exist: role check, enrollment redirect, then on to the console. */
  const finish = async (tokens: AuthTokens) => {
    tokenStore.set(tokens);
    {
      if (mfaEnrollPath) {
        // A back-office account that has no authenticator yet has a session that can do exactly
        // one thing: enroll. Send it there rather than to a console that would refuse it.
        const probe = await api.auth.me();
        if (probe.mfa?.required && !probe.mfa.verified && !probe.mfa.enrolled) {
          router.push(mfaEnrollPath);
          return;
        }
      }
      const me = allowedRoles || backOfficePath ? await api.auth.me() : null;
      if (allowedRoles && me) {
        if (!me.roles.some((r) => allowedRoles.includes(r))) {
          if (roleMismatchRedirect) {
            // Signed in fine, just not set up for this console yet. Keep the session —
            // clearing it here is what made the gap unrecoverable.
            router.push(roleMismatchRedirect);
            return;
          }
          tokenStore.clear();
          setError('This account cannot access this console.');
          setLoading(false);
          return;
        }
      }
      /*
        Only a path on this console. The raw `?next=` was pushed as it came, so a link to
        `/login?next=https://elsewhere` sent somebody who had just typed a password AND an
        authenticator code to any site the link's author chose. `/login` itself falls back too:
        it left the person on the form they had just filled, as if signing in had failed.
      */
      const next = nextFromSearch(
        typeof window !== 'undefined' ? window.location.search : '',
        defaultRedirect,
        CONSOLE_SIGN_IN_PAGES,
      );
      if (backOfficePath && me?.roles.some((r) => BACK_OFFICE_ROLES.includes(r))) {
        router.push(`${backOfficePath}?next=${encodeURIComponent(next)}`);
        return;
      }
      router.push(next);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await api.auth.signIn({ email, password });
      if ('mfaRequired' in result) {
        setChallenge(result.challengeToken);
        setPassword('');
        setLoading(false);
        return;
      }
      await finish(result);
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setError(null);
    setLoading(true);
    try {
      const tokens = await api.auth.mfaVerify({
        challengeToken: challenge,
        ...(useRecovery ? { recoveryCode: mfaCode.trim() } : { code: mfaCode.replace(/\s/g, '') }),
      });
      await finish(tokens);
    } catch (err) {
      setError(errorMessage(err));
      setMfaCode('');
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          {/* The brand, as on every other surface: the one wordmark (wordmark.tsx), where a
              blue ticket tile used to stand in for it. */}
          <div className="mb-5 flex justify-center">
            <Wordmark size="lg" tone="auto" product={product} />
          </div>
          <h1 className="text-h3 font-bold tracking-tight text-text-primary">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[0.9375rem] text-text-muted">{subtitle}</p>}
        </div>
        {notice && (
          <p
            role="status"
            data-testid="signed-out-notice"
            className="mb-4 rounded-lg bg-tint-warning px-4 py-3 text-[0.9375rem] text-status-warning"
          >
            {notice} To work with this team again, ask one of its owners to invite you.
          </p>
        )}
        <Card className="space-y-4">
          {challenge ? (
            <form className="space-y-4" onSubmit={submitCode}>
              <p className="text-[0.9375rem] text-text-muted">
                {useRecovery
                  ? 'Enter one of your recovery codes. Each code works once.'
                  : 'Enter the 6-digit code from your authenticator app.'}
              </p>
              <Input
                id="mfa-code"
                label={useRecovery ? 'Recovery code' : 'Authenticator code'}
                icon={KeyRound}
                autoComplete="one-time-code"
                inputMode={useRecovery ? 'text' : 'numeric'}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                autoFocus
                required
              />
              {error && (
                <p role="alert" className="text-caption text-status-error">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" loading={loading}>
                Verify
              </Button>
              <div className="flex justify-between text-caption">
                <button
                  type="button"
                  className="text-text-muted underline"
                  onClick={() => {
                    setUseRecovery(!useRecovery);
                    setMfaCode('');
                    setError(null);
                  }}
                >
                  {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
                </button>
                <button
                  type="button"
                  className="text-text-muted underline"
                  onClick={() => {
                    setChallenge(null);
                    setMfaCode('');
                    setError(null);
                  }}
                >
                  Start again
                </button>
              </div>
            </form>
          ) : (
            <form className="space-y-4" onSubmit={submit}>
              <Input
                id="email"
                label="Email"
                type="email"
                icon={Mail}
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <Input
                id="password"
                label="Password"
                type="password"
                icon={Lock}
                autoComplete="current-password"
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
                Sign in
              </Button>
            </form>
          )}
        </Card>
        {footer ? <div className="mt-5 space-y-2 text-center text-caption">{footer}</div> : null}
      </div>
    </div>
  );
}
