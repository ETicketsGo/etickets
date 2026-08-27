'use client';

import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { Suspense, useState } from 'react';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Card, Input } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

function LoginForm() {
  const a = useTranslations('storefront.auth');
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/account/tickets';
  // Prefilled when arriving from the "that email is already registered" path on sign-up, so
  // the address does not have to be typed twice.
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
      <p className="text-caption text-text-muted">
        {a('noAccount')}{' '}
        <Link href="/register" className="text-action-primary underline">
          {a('createOne')}
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
