'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Spinner, tokenStore, useAuthUser } from '@eticketsgo/web-kit';

/**
 * Keeps a back-office session that has not passed the second factor out of the console.
 *
 * The API refuses every console request from such a session anyway (MfaGuard); this is the
 * screen-side half, so the person is sent where they can fix it instead of seeing a wall of
 * "could not load" cards:
 *   - no authenticator yet  -> set one up (this is how the existing administrator is migrated);
 *   - has one, session lacks the proof (an old session) -> sign in again.
 * When MFA is not armed on the server, `mfa.required` is false and this passes straight through.
 */
export function MfaGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, isLoading } = useAuthUser();
  const blocked = Boolean(user?.mfa?.required && !user.mfa.verified);

  useEffect(() => {
    if (!blocked || !user?.mfa) return;
    if (!user.mfa.enrolled) {
      router.replace('/enroll-mfa');
    } else {
      tokenStore.clear();
      router.replace('/login');
    }
  }, [blocked, user, router]);

  if (isLoading || blocked) {
    return (
      <div className="flex h-64 items-center justify-center text-text-muted">
        <Spinner />
      </div>
    );
  }
  return <>{children}</>;
}
