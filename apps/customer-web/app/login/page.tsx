'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Card, Input } from '@/components/ui';

function LoginForm() {
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
      setError(err instanceof ApiRequestError ? err.message : 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="mx-auto max-w-sm space-y-4">
      <h1 className="text-h2 font-bold text-text-primary">Sign in</h1>
      <form className="space-y-4" onSubmit={submit}>
        <Input
          id="email"
          label="Email"
          type="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          id="password"
          label="Password"
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
          Sign in
        </Button>
      </form>
      <p className="text-caption text-text-muted">
        No account?{' '}
        <Link href="/register" className="text-action-primary underline">
          Create one
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
