'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useRouter, Link } from '@/i18n/navigation';
import { Button, Card, Input } from '@/components/ui';
import { useTranslations } from 'next-intl';

/**
 * Setting a new password from a reset link.
 *
 * The token arrives in the query string, which is where an emailed link can carry it. It is
 * single-use and short-lived precisely because a URL is the least private place a credential
 * can live — it lands in browser history, and in whatever proxy sits between.
 */
function ResetForm() {
  const a = useTranslations('storefront.auth');
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.resetPassword(token, password);
      /*
        Sent to sign in, not signed in automatically. Holding the link proves control of the
        mailbox, which is enough to SET a password — but the session should start from the
        password they just chose, and every previous session has just been destroyed.
      */
      router.push('/login?reset=1');
    } catch {
      // One message for every refusal, matching the server: telling an expired link apart
      // from a spent one tells somebody holding a stolen link whether to chase a fresher one.
      setError(a('resetLinkBad'));
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <Card className="mx-auto mt-10 max-w-md space-y-3">
        <h1 className="text-title font-semibold text-text-primary">{a('newPasswordTitle')}</h1>
        <p className="text-[0.9375rem] text-text-secondary">{a('resetLinkBad')}</p>
        <Link href="/forgot-password" className="text-caption text-action-primary underline">
          {a('forgotPassword')}
        </Link>
      </Card>
    );
  }

  return (
    <Card className="mx-auto mt-10 max-w-md space-y-4">
      <h1 className="text-title font-semibold text-text-primary">{a('newPasswordTitle')}</h1>
      <form onSubmit={submit} className="space-y-4">
        <Input
          id="password"
          label={a('newPassword')}
          type="password"
          autoComplete="new-password"
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
          {a('newPasswordSave')}
        </Button>
      </form>
      <Link href="/login" className="block text-caption text-action-primary underline">
        {a('backToSignIn')}
      </Link>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}
