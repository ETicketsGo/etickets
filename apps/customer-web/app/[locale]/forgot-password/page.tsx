'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, Card, Input } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

/**
 * Asking for a password reset link.
 *
 * ── WHY THIS SAYS THE SAME THING EITHER WAY ────────────────────────────────────────
 * The confirmation is shown whether or not the address has an account, because the server
 * answers identically and this page must not undo that. A screen that said "no account
 * with that email" would turn the form into a way to discover who holds an account here —
 * and on a ticketing platform, who bought tickets to what.
 *
 * It reads as slightly evasive, and that is the cost. The person who actually owns the
 * address finds out in their inbox, which is the only place it belongs.
 */
export default function ForgotPasswordPage() {
  const a = useTranslations('storefront.auth');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.forgotPassword(email);
    } catch {
      /*
        Swallowed on purpose. A network failure and an unknown address must look the same
        from here, and the only alternative — showing an error — would leak the difference
        the server works to hide.
      */
    } finally {
      setLoading(false);
      setSent(true);
    }
  };

  return (
    <Card className="mx-auto mt-10 max-w-md space-y-4">
      <h1 className="text-title font-semibold text-text-primary">{a('resetTitle')}</h1>

      {sent ? (
        <>
          <p className="text-[0.9375rem] text-text-secondary">{a('resetSent')}</p>
          <Link href="/login" className="text-caption text-action-primary underline">
            {a('backToSignIn')}
          </Link>
        </>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-[0.9375rem] text-text-secondary">{a('resetLead')}</p>
          <Input
            id="email"
            label={a('email')}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Button type="submit" className="w-full" loading={loading}>
            {a('resetSend')}
          </Button>
          <Link href="/login" className="block text-caption text-action-primary underline">
            {a('backToSignIn')}
          </Link>
        </form>
      )}
    </Card>
  );
}
