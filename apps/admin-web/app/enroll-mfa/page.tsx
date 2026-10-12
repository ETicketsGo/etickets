'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import {
  api,
  Button,
  Card,
  errorMessage,
  Input,
  tokenStore,
  type MfaEnrollment,
} from '@eticketsgo/web-kit';
import { RecoveryCodes } from '@/components/recovery-codes';

/**
 * Set up the authenticator. This is where an administrator lands after the password step when
 * their account has none yet: their session can do this and nothing else until they finish.
 *
 * Three steps: confirm the password, scan the code (or type the key) and prove it works with the
 * first code, then save the recovery codes. The QR is drawn by our own API and shown as an image;
 * the key never goes to any other site.
 */
export default function EnrollMfaPage() {
  const router = useRouter();
  const [step, setStep] = useState<'password' | 'scan' | 'codes'>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!tokenStore.access) router.replace('/login');
  }, [router]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await api.auth.mfaEnrollStart(password));
      setPassword('');
      setStep('scan');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.auth.mfaEnrollConfirm(code.replace(/\s/g, ''));
      // The pre-enrollment sessions were ended by the server; this is the verified one.
      tokenStore.set({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      setRecoveryCodes(res.recoveryCodes);
      setEnrollment(null);
      setStep('codes');
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background-canvas p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-action-primary text-action-primary-foreground shadow-md">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="text-h3 font-bold tracking-tight text-text-primary">
            Set up your authenticator
          </h1>
          <p className="mt-1.5 text-[0.9375rem] text-text-muted">
            Back-office accounts need a second step when they sign in.
          </p>
        </div>
        <Card className="space-y-4">
          {step === 'password' && (
            <form className="space-y-4" onSubmit={start}>
              <p className="text-[0.9375rem] text-text-primary">
                First, enter your password again to show it is you.
              </p>
              <Input
                id="enroll-password"
                label="Password"
                type="password"
                icon={Lock}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                required
              />
              {error && (
                <p role="alert" className="text-caption text-status-error">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" loading={busy}>
                Continue
              </Button>
            </form>
          )}

          {step === 'scan' && enrollment && (
            <form className="space-y-4" onSubmit={confirm}>
              <p className="text-[0.9375rem] text-text-primary">
                Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password,
                Authy) and scan this code.
              </p>
              {/* An img with a data URL: the SVG is drawn as a picture and can never run script. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt="QR code for your authenticator app"
                className="mx-auto h-56 w-56 rounded-md bg-white p-2"
                src={`data:image/svg+xml;utf8,${encodeURIComponent(enrollment.qrSvg)}`}
              />
              <div>
                <p className="text-caption text-text-muted">Cannot scan? Type this key instead.</p>
                <input
                  readOnly
                  aria-label="Setup key"
                  value={enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}
                  onFocus={(e) => e.currentTarget.select()}
                  className="mt-1 w-full rounded-md border border-border bg-background-surface px-3 py-2 font-mono text-caption text-text-primary"
                />
              </div>
              <Input
                id="enroll-code"
                label="Code from the app"
                autoComplete="one-time-code"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
              {error && (
                <p role="alert" className="text-caption text-status-error">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" loading={busy}>
                Turn on
              </Button>
            </form>
          )}

          {step === 'codes' && (
            <RecoveryCodes codes={recoveryCodes} onDone={() => router.replace('/admin')} />
          )}
        </Card>
      </div>
    </div>
  );
}
