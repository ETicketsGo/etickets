'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { tokenStore, Spinner } from '@eticketsgo/web-kit';

export default function Index() {
  const router = useRouter();
  useEffect(() => {
    router.replace(tokenStore.access ? '/admin' : '/login');
  }, [router]);
  return (
    <div className="flex min-h-screen items-center justify-center text-text-muted">
      <Spinner />
    </div>
  );
}
