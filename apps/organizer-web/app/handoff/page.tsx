'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  LoginForm,
  Spinner,
  Wordmark,
  api,
  errorMessage,
  tokenStore,
} from '@eticketsgo/web-kit';
import { afterHandoff, takeHandoffCode } from '@/lib/handoff';

const CONSOLE_ROLES = [
  'ORGANIZER_OWNER',
  'ORGANIZER_MANAGER',
  'CHECKIN_STAFF',
  'ADMIN',
  'SUPER_ADMIN',
];

/**
 * Where the storefront's "Organizer console" link lands: `/handoff#code=<one-time code>`.
 *
 * The code is taken out of the address bar and history before anything else, then spent once at
 * `POST /auth/handoff/exchange` for a session of this console's own (see the API's
 * handoff.service.ts). A back-office account is answered with its second-factor challenge, which
 * is completed here on the ordinary sign-in card - the handoff never skips it.
 */
export default function HandoffPage() {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<
    { kind: 'working' } | { kind: 'challenge'; token: string } | { kind: 'failed'; message: string }
  >({ kind: 'working' });

  useEffect(() => {
    // Once per page, including React's development double-run: the code works only once.
    if (started.current) return;
    started.current = true;
    const code = takeHandoffCode(window.location, window.history);
    if (!code) {
      setState({
        kind: 'failed',
        message:
          'This sign-in link is not complete. Open the organizer console again from your account, or sign in here.',
      });
      return;
    }
    void (async () => {
      try {
        const result = await api.auth.exchangeHandoff(code, 'organizer');
        if ('mfaRequired' in result) {
          setState({ kind: 'challenge', token: result.challengeToken });
          return;
        }
        tokenStore.set(result);
        const me = await api.auth.me();
        router.replace(afterHandoff(me.roles));
      } catch (err) {
        setState({ kind: 'failed', message: errorMessage(err) });
      }
    })();
  }, [router]);

  if (state.kind === 'challenge') {
    return (
      <LoginForm
        product="Organizer"
        title="Organizer sign in"
        subtitle="Confirm it is you to continue."
        defaultRedirect="/organizer"
        roleMismatchRedirect="/start"
        backOfficePath="/back-office"
        allowedRoles={CONSOLE_ROLES}
        initialChallenge={state.token}
      />
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Wordmark size="lg" tone="auto" product="Organizer" />
        </div>
        <Card className="space-y-4 text-center">
          {state.kind === 'working' ? (
            <div role="status" className="flex flex-col items-center gap-3 py-2">
              <Spinner />
              <p className="text-[0.9375rem] text-text-muted">Signing you in to the console.</p>
            </div>
          ) : (
            <>
              <p
                role="alert"
                data-testid="handoff-failed"
                className="text-[0.9375rem] text-text-primary"
              >
                {state.message}
              </p>
              <Button className="w-full" onClick={() => router.replace('/login')}>
                Sign in
              </Button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
