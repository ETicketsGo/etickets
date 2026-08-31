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
} from '@eticketsgo/web-kit';

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
    mutationFn: () =>
      api.invitations.accept(token, {
        ...(summary.data?.needsPassword ? { fullName, password } : {}),
      }),
    onSuccess: (result) => {
      toast.push(`You have joined ${result.organizationName}.`, 'success');
      /*
        Sent to sign in rather than signed in automatically.

        Accepting proves they hold the link, which is not the same as proving they are the
        person — and for an invitee who already had an account we never asked for a password
        at all. Signing somebody in on the strength of a forwarded URL is exactly the hole
        the token was meant to close.
      */
      router.push('/login');
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
            This invitation can&rsquo;t be used
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
  const roleLabel = invite.role.replaceAll('_', ' ').toLowerCase();
  const canSubmit = !invite.needsPassword || (fullName.trim().length > 0 && password.length > 0);

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="w-full max-w-md">
        <h1 className="text-title font-semibold text-text-primary">
          Join {invite.organizationName}
        </h1>
        <p className="mt-2 text-[0.9375rem] text-text-secondary">
          You&rsquo;ve been invited as <strong>{roleLabel}</strong>, for {invite.email}.
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
              <Input
                id="password"
                label="Choose a password"
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          ) : (
            <p className="rounded-md border border-border bg-background-canvas p-3 text-caption text-text-secondary">
              You already have an ETicketsGo account for this address. Accepting adds this
              organization to it — your password does not change.
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
