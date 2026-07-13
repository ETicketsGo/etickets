'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { api, tokenStore, ApiRequestError } from '@/lib/api';
import { Button, Card, Input } from '@/components/ui';

export default function RegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tokens = await api.register({ fullName, email, password });
      tokenStore.set(tokens);
      router.push('/account/tickets');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="mx-auto max-w-sm space-y-4">
      <h1 className="text-h2 font-bold text-text-primary">Create your account</h1>
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
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          id="password"
          label="Password (min 8 chars)"
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
          Create account
        </Button>
      </form>
      <p className="text-caption text-text-muted">
        Already have an account?{' '}
        <Link href="/login" className="text-action-primary">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
