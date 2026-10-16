'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  api,
  Button,
  ButtonLink,
  Card,
  Input,
  Spinner,
  errorMessage,
  useToast,
  PasswordField,
  passwordAcceptable,
  DEFAULT_PASSWORD_FIELD_COPY,
  tokenStore,
} from '@eticketsgo/web-kit';

const ROLE_WORDS: Record<string, string> = {
  ORGANIZER_OWNER: 'an owner',
  ORGANIZER_MANAGER: 'a manager',
  CHECKIN_STAFF: 'check-in staff',
};

/**
 * Where an invited team member joins.
 *
 * ── WHY THIS PAGE EXISTS ───────────────────────────────────────────────────────────
 * Inviting somebody used to add an OrganizationMember at status INVITED and stop. Nothing
 * ever moved a member to ACTIVE, and access requires ACTIVE — so every invited person was
 * locked out. If they had no account, the invite also created one with a random password
 * nobody could know, which then made self-registration fail with "email already
 * registered". There is no password-reset flow, so that address was finished.
 *
 * This is the missing half. Accepting here is the only thing that makes a member ACTIVE.
 *
 * It sits OUTSIDE `/organizer` deliberately: everything under that path requires a session,
 * and an invitation that can only be opened by somebody who can already sign in is a door
 * that opens from the inside.
 */
export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const toast = useToast();

  const summary = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.invitations.describe(token),
    retry: false,
  });

  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');

  const accept = useMutation({
    mutationFn: async () => {
      const needsPassword = Boolean(summary.data?.needsPassword);
      const result = await api.invitations.accept(token, {
        ...(needsPassword ? { fullName, password } : {}),
      });
      /*
        ── SIGNED IN WITH THE PASSWORD THEY JUST CHOSE, NEVER WITH THE LINK ─────────────
        Accepting proves they hold the link, which is not the same as proving they are the
        person, so the link alone never signs anybody in. But somebody who has just CHOSEN a
        password has typed the credential a sign-in asks for, and sending them to a sign-in
        page to type it again (with the address blank) was the first thing their new console
        asked of them. That is an ordinary sign-in with what they typed. An invitee who
        already had an account gave no password here and still signs in themselves.
      */
      if (needsPassword && result.email) {
        try {
          const signed = await api.auth.signIn({ email: result.email, password });
          if (!('mfaRequired' in signed)) {
            tokenStore.set(signed);
            return { result, signedIn: true };
          }
        } catch {
          // Fall through to the sign-in page; accepting already worked.
        }
      }
      return { result, signedIn: false };
    },
    onSuccess: ({ result, signedIn }) => {
      toast.push(`You have joined ${result.organizationName}.`, 'success');
      router.push(
        signedIn ? '/organizer' : `/login?email=${encodeURIComponent(result.email ?? '')}`,
      );
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

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
          {/*
            The server's own words. It distinguishes expired from spent from withdrawn, and
            each has a different thing the reader should do next — replacing all three with
            "invalid link" would throw away the only actionable part.
          */}
          <p className="mt-2 text-[0.9375rem] text-text-secondary">{errorMessage(summary.error)}</p>
          <ButtonLink href="/login" className="mt-5 w-full">
            Go to sign in
          </ButtonLink>
        </Card>
      </main>
    );
  }

  const invite = summary.data!;
  const roleLabel = ROLE_WORDS[invite.role] ?? invite.role.replaceAll('_', ' ').toLowerCase();
  const canSubmit =
    !invite.needsPassword ||
    (fullName.trim().length > 0 &&
      passwordAcceptable(password, { email: invite.email, name: fullName }));

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="w-full max-w-md">
        <h1 className="text-title font-semibold text-text-primary">
          Join {invite.organizationName}
        </h1>
        <p className="mt-2 text-[0.9375rem] text-text-secondary">
          You have been invited as <strong>{roleLabel}</strong>, for {invite.email}.
        </p>

        <div className="mt-5 space-y-4">
          {invite.needsPassword ? (
            <>
              {/*
                Only asked of somebody the invitation created. An invitee who already had an
                account keeps the password they know — offering to set a new one would let
                anybody holding a forwarded link take over an existing user.
              */}
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
            </>
          ) : (
            <p className="rounded-md border border-border bg-background-canvas p-3 text-caption text-text-secondary">
              You already have an ETicketsGo account for this address. Accepting adds this
              organization to it. Your password does not change.
            </p>
          )}

          <Button
            className="w-full"
            loading={accept.isPending}
            disabled={!canSubmit}
            onClick={() => accept.mutate()}
          >
            {invite.needsPassword ? 'Create account and join' : 'Accept invitation'}
          </Button>
        </div>
      </Card>
    </main>
  );
}
