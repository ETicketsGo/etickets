'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  ButtonLink,
  Card,
  Input,
  Spinner,
  errorMessage,
  PasswordField,
  passwordAcceptable,
  DEFAULT_PASSWORD_FIELD_COPY,
} from '@eticketsgo/web-kit';

const CODE_FIELD = /^\d{6}$/;

/**
 * Where an invited back-office colleague claims their account.
 *
 * A back-office invitation always creates the account (the staff screen refuses an address that
 * already has one), and its duties are granted when it is sent - inert until the account has a
 * password. So claiming the account IS accepting here: there is no team to join afterwards.
 *
 * ── WHAT CHANGED (owner decision, 2026-10-26) ─────────────────────────────────────
 * The link alone used to set the password, and the inviting administrator was shown the link -
 * so the inviter could choose a new colleague's password and sign in as them, with their
 * duties. Now the link is emailed to the invitee only, and claiming needs a code sent to that
 * address as well: the mailbox is proved, whoever else sees the link.
 *
 * It sits OUTSIDE `/admin` because everything under that path requires a session.
 */
export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();

  const summary = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.invitations.describe(token),
    retry: false,
  });

  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (summary.isLoading) {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <Spinner />
      </main>
    );
  }

  if (summary.isError) {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <Card className="w-full max-w-md">
          <h1 className="text-title font-semibold text-text-primary">
            This invitation cannot be used
          </h1>
          {/* The server's own words: expired, spent and withdrawn each say what to do next. */}
          <p className="mt-2 text-[0.9375rem] text-text-secondary">{errorMessage(summary.error)}</p>
          <ButtonLink href="/login" className="mt-5 w-full">
            Go to sign in
          </ButtonLink>
        </Card>
      </main>
    );
  }

  const invite = summary.data!;
  const canClaim =
    CODE_FIELD.test(code.trim()) &&
    fullName.trim().length > 0 &&
    passwordAcceptable(password, { email: invite.email, name: fullName });

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="w-full max-w-md">
        <h1 className="text-title font-semibold text-text-primary">Join the back office</h1>

        {done ? (
          <>
            <p className="mt-2 text-[0.9375rem] text-text-secondary">
              Your account for {invite.email} is ready. Sign in with your new password. You will
              then set up your authenticator app.
            </p>
            <ButtonLink href="/login" className="mt-5 w-full">
              Go to sign in
            </ButtonLink>
          </>
        ) : !invite.needsPassword ? (
          <>
            <p className="mt-2 text-[0.9375rem] text-text-secondary">
              You already have an ETicketsGo account for {invite.email}. Sign in with it.
            </p>
            <ButtonLink href="/login" className="mt-5 w-full">
              Go to sign in
            </ButtonLink>
          </>
        ) : (
          <>
            <p className="mt-2 text-[0.9375rem] text-text-secondary">
              You have been invited to the ETicketsGo back office, for {invite.email}. Your duties
              are already set. We send a code to that address to check that it is yours, then you
              choose a password.
            </p>
            <div className="mt-5 space-y-4">
              {!codeSent ? (
                <Button
                  className="w-full"
                  loading={busy}
                  onClick={() =>
                    run(async () => {
                      await api.invitations.requestAccountCode(token);
                      setCodeSent(true);
                    })
                  }
                >
                  Send me a code
                </Button>
              ) : (
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!canClaim) return;
                    void run(async () => {
                      await api.invitations.claimAccount(token, {
                        code: code.trim(),
                        fullName: fullName.trim(),
                        password,
                      });
                      setDone(true);
                    });
                  }}
                >
                  <Input
                    id="invite-code"
                    label={`The code we sent to ${invite.email}`}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <Input
                    id="fullName"
                    label="Your name"
                    value={fullName}
                    autoComplete="name"
                    onChange={(e) => setFullName(e.target.value)}
                  />
                  <PasswordField
                    id="password"
                    value={password}
                    onChange={setPassword}
                    context={{ email: invite.email, name: fullName }}
                    copy={{ ...DEFAULT_PASSWORD_FIELD_COPY, label: 'Choose a password' }}
                  />
                  <Button type="submit" className="w-full" loading={busy} disabled={!canClaim}>
                    Create account
                  </Button>
                </form>
              )}
              {error && (
                <p role="alert" className="text-[0.9375rem] text-status-error">
                  {error}
                </p>
              )}
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
