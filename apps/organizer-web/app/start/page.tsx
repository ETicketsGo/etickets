'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Button,
  Card,
  Input,
  RequireAuth,
  Spinner,
  api,
  errorMessage,
  tokenStore,
  useAuthUser,
} from '@eticketsgo/web-kit';

/**
 * Create the organization that turns an account into an organizer account.
 *
 * ── WHY THIS PAGE EXISTS ──────────────────────────────────────────────────────────
 * Every account is created with the CUSTOMER role. The ORGANIZER_OWNER role is granted by
 * creating an organization — and until this page, the only way to do that was
 * `POST /organizations`. The product said so out loud: the organizer console's empty state
 * read "create one via the API".
 *
 * So the journey "I want to sell tickets" ended in one of two dead ends. Sign in here and
 * the login screen refused you — "This account cannot access this console" — and threw the
 * session away. Register with organizer intent on the customer site and you were redirected
 * to this app, signed out, to be refused by that same screen.
 *
 * This page sits OUTSIDE `/organizer` deliberately: everything under that path requires the
 * role this page exists to grant, so putting it there would have reproduced the loop.
 */
const ORGANIZER_ROLES = ['ORGANIZER_OWNER', 'ORGANIZER_MANAGER', 'ADMIN', 'SUPER_ADMIN'];

function StartInner() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuthUser();
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Somebody who already has an organization does not need this page. Sent on rather than
  // shown a form that would create a second one by accident.
  const mine = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: () => api.organizations.listMine(),
  });

  const alreadySetUp =
    (mine.data && mine.data.length > 0) ||
    (user?.roles ?? []).some((r) => ORGANIZER_ROLES.includes(r));

  const create = useMutation({
    mutationFn: async () => {
      const org = await api.organizations.create({
        name: name.trim(),
        contactEmail: contactEmail.trim() || undefined,
      });
      /*
        Refresh the session before navigating.

        Creating the organization granted ORGANIZER_OWNER in the database, but the access
        token in this browser still describes the account as it was a second ago. Navigating
        on that token puts the operator straight back into "your account role cannot access
        this area" — having just done the thing that was supposed to fix it.
      */
      const refresh = tokenStore.refresh;
      if (refresh) {
        const tokens = await api.auth.refresh(refresh);
        tokenStore.set(tokens);
      }
      await qc.invalidateQueries();
      return org;
    },
    onSuccess: () => router.replace('/organizer'),
    onError: (e) => setError(errorMessage(e)),
  });

  if (mine.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-text-muted">
        <Spinner />
      </div>
    );
  }

  if (alreadySetUp) {
    return (
      <Card className="mx-auto max-w-sm space-y-4 text-center">
        <h1 className="text-h2 font-bold text-text-primary">You are all set</h1>
        <p className="text-caption text-text-muted">
          This account already belongs to an organization.
        </p>
        <Button className="w-full" onClick={() => router.replace('/organizer')}>
          Go to your console
        </Button>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-sm space-y-4">
      <div>
        <h1 className="text-h2 font-bold text-text-primary">Set up your organization</h1>
        <p className="mt-1 text-caption text-text-muted">
          One step. This is the business that sells the tickets — it appears on customer receipts,
          and it is what gives this account access to the organizer console.
        </p>
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <Input
          id="org-name"
          label="Organization name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          minLength={2}
          required
        />
        <Input
          id="org-contact"
          label="Support email (optional)"
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
        />

        {error ? (
          <p role="alert" className="text-caption text-status-error">
            {error}
          </p>
        ) : null}

        <Button
          type="submit"
          className="w-full"
          loading={create.isPending}
          disabled={create.isPending || name.trim().length < 2}
        >
          Create organization
        </Button>
      </form>

      <p className="text-caption text-text-muted">
        New organizations are reviewed by ETicketsGo before they can sell. You can set everything
        else up while that happens.
      </p>
    </Card>
  );
}

export default function StartPage() {
  // Authentication only — no role gate. Requiring an organizer role on the page that GRANTS
  // the organizer role is the loop this whole screen exists to break.
  return (
    <div className="flex min-h-screen items-center justify-center bg-background-canvas p-4">
      <RequireAuth>
        <StartInner />
      </RequireAuth>
    </div>
  );
}
