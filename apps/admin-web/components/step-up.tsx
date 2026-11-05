'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import {
  api,
  Button,
  Dialog,
  errorMessage,
  Input,
  setMfaSetupHandler,
  setStepUpHandler,
  tokenStore,
  type MfaSetupCode,
} from '@eticketsgo/web-kit';
import { registerStepUp } from '@/lib/step-up-bridge';

/**
 * Asks for a fresh authenticator code when the API says a sensitive action needs one.
 *
 * Registers ONE handler with the shared request layer: any call that comes back
 * MFA_STEP_UP_REQUIRED opens this dialog, and once a code is accepted the original request is
 * repeated automatically. The new access token replaces the old one; the refresh token is kept.
 *
 * While MFA enrollment is deferred, a sensitive action by someone with no authenticator comes
 * back MFA_SETUP_REQUIRED (offer the setup screen) or MFA_NOT_CONFIGURED (nothing they can do:
 * an operator must turn MFA on). Both are explained here, in the API's own words.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ code: MfaSetupCode; message: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const settle = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        settle.current?.(false);
        settle.current = resolve;
        setCode('');
        setError(null);
        setRecovery(false);
        setOpen(true);
      }),
    [],
  );

  useEffect(() => {
    setStepUpHandler(ask);
    return () => setStepUpHandler(null);
  }, [ask]);

  useEffect(() => {
    setMfaSetupHandler((code, message) => setSetup({ code, message }));
    return () => setMfaSetupHandler(null);
  }, []);

  // The same dialog for the requests this app makes itself (`lib/step-up-bridge.ts`).
  useEffect(() => {
    registerStepUp(ask, (code, message) => setSetup({ code, message }));
    return () => registerStepUp(null, null);
  }, [ask]);

  const finish = (ok: boolean) => {
    setOpen(false);
    settle.current?.(ok);
    settle.current = null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { accessToken } = await api.auth.mfaStepUp(
        recovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, '') },
      );
      const refreshToken = tokenStore.refresh;
      if (refreshToken) tokenStore.set({ accessToken, refreshToken });
      finish(true);
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {children}
      <Dialog
        open={open}
        onClose={() => finish(false)}
        title="Confirm it is you"
        description="This action needs a fresh code from your authenticator app."
      >
        <form className="space-y-4" onSubmit={submit}>
          <Input
            id="step-up-code"
            label={recovery ? 'Recovery code' : 'Authenticator code'}
            icon={KeyRound}
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
            required
          />
          {error && (
            <p role="alert" className="text-caption text-status-error">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="text-caption text-text-muted underline"
              onClick={() => {
                setRecovery(!recovery);
                setCode('');
                setError(null);
              }}
            >
              {recovery ? 'Use authenticator code' : 'Use a recovery code'}
            </button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => finish(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Confirm
              </Button>
            </div>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={setup !== null}
        onClose={() => setSetup(null)}
        title={
          setup?.code === 'MFA_NOT_CONFIGURED'
            ? 'Two-step sign-in is not turned on'
            : 'Set up two-step sign-in first'
        }
        description="This action needs a code from an authenticator app."
      >
        <div className="space-y-4">
          <p className="text-[0.9375rem] text-text-primary">{setup?.message}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setSetup(null)}>
              {setup?.code === 'MFA_SETUP_REQUIRED' ? 'Not now' : 'Close'}
            </Button>
            {setup?.code === 'MFA_SETUP_REQUIRED' && (
              <Button
                type="button"
                onClick={() => {
                  setSetup(null);
                  router.push('/enroll-mfa');
                }}
              >
                Set up two-step sign-in
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
