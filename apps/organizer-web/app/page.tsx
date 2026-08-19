'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { tokenStore, Spinner } from '@eticketsgo/web-kit';

export default function Index() {
  const router = useRouter();
  useEffect(() => {
    // Signed in -> the console, which itself forwards to /start if no organization exists.
    // Signed out -> sign in, which does the same after a successful login.
    router.replace(tokenStore.access ? '/organizer' : '/login');
  }, [router]);
  return (
    <div className="flex min-h-screen items-center justify-center text-text-muted">
      <Spinner />
    </div>
  );
}
