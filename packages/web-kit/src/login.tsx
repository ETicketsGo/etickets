'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Lock, Mail, Ticket } from 'lucide-react';
import { api, errorMessage, tokenStore } from './api';
import { Button, Card, Input } from './components';

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
}) {
  const router = useRouter();
  const [email, setEmail] = useState(defaultEmail ?? '');
  // Never pre-fill the password — shipping a real credential in a launch build is unsafe.
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tokens = await api.auth.login({ email, password });
      tokenStore.set(tokens);
      if (allowedRoles) {
        const me = await api.auth.me();
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
      const next =
        (typeof window !== 'undefined' &&
          new URLSearchParams(window.location.search).get('next')) ||
        defaultRedirect;
      router.push(next);
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-action-primary text-action-primary-foreground shadow-md">
            <Ticket className="h-6 w-6" />
          </div>
          <h1 className="text-h3 font-bold tracking-tight text-text-primary">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[0.9375rem] text-text-muted">{subtitle}</p>}
        </div>
        <Card className="space-y-4">
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
        </Card>
      </div>
    </div>
  );
}
