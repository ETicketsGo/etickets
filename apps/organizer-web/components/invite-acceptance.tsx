'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  api,
  ApiRequestError,
  Button,
  ButtonLink,
  Card,
  Input,
  LoginForm,
  PasswordField,
  Spinner,
  DEFAULT_PASSWORD_FIELD_COPY,
  EMAIL_NOT_VERIFIED_CODE,
  INVITATION_WRONG_ACCOUNT_CODE,
  errorMessage,
  passwordAcceptable,
  tokenStore,
  type InvitationSummary,
} from '@eticketsgo/web-kit';

const ROLE_WORDS: Record<string, string> = {
  ORGANIZER_OWNER: 'an owner',
  ORGANIZER_MANAGER: 'a manager',
  CHECKIN_STAFF: 'check-in staff',
};

const CODE_FIELD = /^\d{6}$/;

/** Signed in on this console right now, kept current as tokens come and go. */
function useSignedIn(): boolean {
  return useSyncExternalStore(
    (l) => tokenStore.subscribe(l),
    () => !!tokenStore.access,
    () => false,
  );
}

type Stage = 'ready' | 'verify' | 'wrong' | 'joined';

/**
 * Accepting a team invitation, as the invited person and nobody else.
 *
 * ── WHAT CHANGED (owner decision, 2026-10-26) ─────────────────────────────────────
 * Holding the link used to be enough: an account that already existed joined with no sign-in,
 * and a new address got its password set by whoever held the link - and the inviting owner was
 * shown the link. Now the link only says what the invitation is for. To accept:
 *   - an existing account signs in (email or mobile), and its email must be confirmed - a code
 *     is sent to it if it never was;
 *   - an account the invitation created is claimed first, with a code sent to the invited
 *     address, a name and a password; then it is signed in and accepts like anybody else;
 *   - signed in as anybody else (the inviter included), the API refuses, and the page offers
 *     to sign out.
 * The API decides every one of these; this page only walks the person through them.
 */
export function InviteAcceptance({
  token,
  onJoined = (path) => window.location.assign(path),
}: {
  token: string;
  /** Where to go once joined. A full load, so the console reads the new seat fresh. */
  onJoined?: (path: string) => void;
}) {
  const signedIn = useSignedIn();
  const [summary, setSummary] = useState<InvitationSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('ready');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinedName, setJoinedName] = useState('');

  // Confirming an email, and claiming a new account.
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    let live = true;
    api.invitations
      .describe(token)
      .then((s) => live && setSummary(s))
      .catch((e) => live && setLoadError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [token]);

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

  const accept = () =>
    run(async () => {
      try {
        const result = await api.invitations.accept(token);
        setJoinedName(result.organizationName);
        setStage('joined');
        onJoined('/organizer');
      } catch (e) {
        if (e instanceof ApiRequestError && e.code === EMAIL_NOT_VERIFIED_CODE) {
          setStage('verify');
          setCodeSent(false);
          setCode('');
          return;
        }
        if (e instanceof ApiRequestError && e.code === INVITATION_WRONG_ACCOUNT_CODE) {
          setStage('wrong');
          return;
        }
        throw e;
      }
    });

  const signOut = () =>
    run(async () => {
      const refresh = tokenStore.refresh;
      if (refresh) await api.auth.logout(refresh).catch(() => undefined);
      tokenStore.clear();
      setStage('ready');
    });

  if (loadError) {
    return (
      <Shell>
        <h1 className="text-title font-semibold text-text-primary">
          This invitation cannot be used
        </h1>
        {/* The server's own words: expired, spent and withdrawn each say what to do next. */}
        <p className="mt-2 text-[0.9375rem] text-text-secondary">{loadError}</p>
        <ButtonLink href="/login" className="mt-5 w-full">
          Go to sign in
        </ButtonLink>
      </Shell>
    );
  }
  if (!summary) {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <Spinner />
      </main>
    );
  }

  const roleLabel = ROLE_WORDS[summary.role] ?? summary.role.replaceAll('_', ' ').toLowerCase();
  const heading = (
    <>
      <h1 className="text-title font-semibold text-text-primary">
        Join {summary.organizationName}
      </h1>
      <p className="mt-2 text-[0.9375rem] text-text-secondary">
        You have been invited as <strong>{roleLabel}</strong>, for <strong>{summary.email}</strong>.
        Only the person with this email address can accept.
      </p>
    </>
  );
  const errorLine = error ? (
    <p role="alert" className="mt-3 text-[0.9375rem] text-status-error">
      {error}
    </p>
  ) : null;

  if (stage === 'joined') {
    return (
      <Shell>
        <h1 className="text-title font-semibold text-text-primary">You have joined {joinedName}</h1>
        <p className="mt-2 text-[0.9375rem] text-text-secondary">Opening the organizer console.</p>
      </Shell>
    );
  }

  // ── Not signed in: an existing account signs in; a new one is claimed first ──
  if (!signedIn && !summary.needsPassword) {
    return (
      <LoginForm
        product="Organizer"
        title={`Sign in to join ${summary.organizationName}`}
        subtitle={`Sign in with ${summary.email} to accept this invitation.`}
        defaultEmail={summary.email}
        // Back to this page, signed in. No role check: joining is what gives the role.
        defaultRedirect={`/invite/${token}`}
        phoneSignIn
      />
    );
  }

  if (!signedIn && summary.needsPassword) {
    const canClaim =
      CODE_FIELD.test(code.trim()) &&
      fullName.trim().length > 0 &&
      passwordAcceptable(password, { email: summary.email, name: fullName });
    return (
      <Shell>
        {heading}
        <p className="mt-3 text-[0.9375rem] text-text-secondary">
          First, create your ETicketsGo account for this address. We send a code to {summary.email}{' '}
          to check that it is yours.
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
                  // An ordinary sign-in with what they just chose, then the same accept as anybody.
                  const signed = await api.auth.signIn({ email: summary.email, password });
                  if ('mfaRequired' in signed) {
                    throw new Error('Your account is ready. Sign in to finish joining.');
                  }
                  tokenStore.set(signed);
                  await accept();
                });
              }}
            >
              <Input
                id="invite-code"
                label={`The code we sent to ${summary.email}`}
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
                context={{ email: summary.email, name: fullName }}
                copy={{ ...DEFAULT_PASSWORD_FIELD_COPY, label: 'Choose a password' }}
              />
              <Button type="submit" className="w-full" loading={busy} disabled={!canClaim}>
                Create account and join
              </Button>
            </form>
          )}
          {errorLine}
        </div>
      </Shell>
    );
  }

  // ── Signed in ──
  if (stage === 'wrong') {
    return (
      <Shell>
        {heading}
        <p className="mt-3 rounded-md border border-border bg-background-canvas p-3 text-[0.9375rem] text-text-primary">
          You are signed in with a different account. This invitation is for {summary.email}. Sign
          out, then sign in with that address to accept it.
        </p>
        <Button className="mt-4 w-full" loading={busy} onClick={() => void signOut()}>
          Sign out
        </Button>
        {errorLine}
      </Shell>
    );
  }

  if (stage === 'verify') {
    return (
      <Shell>
        {heading}
        <p className="mt-3 text-[0.9375rem] text-text-secondary">
          Confirm your email address first. We send a code to {summary.email}.
        </p>
        <div className="mt-5 space-y-4">
          {!codeSent ? (
            <Button
              className="w-full"
              loading={busy}
              onClick={() =>
                run(async () => {
                  await api.auth.requestEmailConfirmCode();
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
                if (!CODE_FIELD.test(code.trim())) return;
                void run(async () => {
                  await api.auth.confirmEmail(code.trim());
                  await accept();
                });
              }}
            >
              <Input
                id="confirm-code"
                label={`The code we sent to ${summary.email}`}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button
                type="submit"
                className="w-full"
                loading={busy}
                disabled={!CODE_FIELD.test(code.trim())}
              >
                Confirm and join
              </Button>
            </form>
          )}
          {errorLine}
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {heading}
      <Button className="mt-5 w-full" loading={busy} onClick={() => void accept()}>
        Accept invitation
      </Button>
      <button
        type="button"
        onClick={() => void signOut()}
        className="mt-3 w-full text-center text-caption font-semibold text-text-secondary underline underline-offset-4"
      >
        Not you? Sign out
      </button>
      {errorLine}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="w-full max-w-md">{children}</Card>
    </main>
  );
}
