'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import {
  Button,
  Card,
  RequireAuth,
  Spinner,
  activeOrganizationSentenceName,
  api,
  safeNextPath,
  tokenStore,
  useAuthUser,
} from '@eticketsgo/web-kit';
import { adminConsoleOrigin, adminSignInUrl, backOfficeRoute } from '@/lib/admin-console-url';

/**
 * Where an administrator goes after signing in to the ORGANIZER console.
 *
 * ── WHY THIS PAGE EXISTS ──────────────────────────────────────────────────────────
 * The organizer console admits back-office accounts, so an administrator who signed in here
 * landed in whichever organization they belonged to. On QA the admin account is an Owner of
 * one, and signing in showed that organization's Overview, "Not approved" banner and all. The
 * owner: "when I sign in as Admin it should take to dashboard view not the other view".
 *
 * So the admin console is the default, and an administrator who is ALSO a member of an
 * organization gets the choice, because that membership is real and sometimes the point.
 *
 * The admin console is a different site with its own sign-in and its own authenticator step.
 * No session is carried across: this one is signed out on the way, so the next visit here does
 * not silently reopen the organization either, and the admin console asks for the password and
 * code as it always does.
 */
function BackOfficeInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { user } = useAuthUser();
  // Where they would have gone: the organizer page they came for, or Overview.
  const next = safeNextPath(params.get('next'), '/organizer', ['/login', '/back-office']);
  const [admin, setAdmin] = useState<string | null | undefined>(undefined);
  useEffect(() => setAdmin(adminConsoleOrigin(window.location)), []);
  const [leaving, setLeaving] = useState(false);

  const orgs = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: () => api.organizations.listMine(),
    enabled: Boolean(user),
  });

  const openAdmin = async () => {
    if (!admin) return;
    setLeaving(true);
    const refresh = tokenStore.refresh;
    if (refresh) await api.auth.logout(refresh).catch(() => undefined);
    tokenStore.clear();
    window.location.assign(adminSignInUrl(admin, user?.email));
  };

  const memberships = orgs.data ?? [];
  const route =
    user && orgs.isSuccess && admin !== undefined
      ? backOfficeRoute({
          roles: user.roles,
          adminOrigin: admin,
          organizationCount: memberships.length,
        })
      : null;

  useEffect(() => {
    if (route === 'stay') router.replace(next);
    if (route === 'admin') void openAdmin();
    // openAdmin reads the same state; running it once per decision is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  if (orgs.isError) {
    // Without the list there is no organization to offer; the admin console is still right.
    return (
      <Card className="mx-auto max-w-sm space-y-4 text-center">
        <h1 className="text-h3 font-bold text-text-primary">You signed in with an admin account</h1>
        <Button className="w-full" onClick={() => void openAdmin()} disabled={!admin}>
          Open the admin console
        </Button>
        <Button variant="outline" className="w-full" onClick={() => router.replace(next)}>
          Continue to the organizer workspace
        </Button>
      </Card>
    );
  }

  if (route !== 'choose' || leaving) {
    return (
      <div className="flex h-64 items-center justify-center text-text-muted">
        <Spinner />
      </div>
    );
  }

  const orgName =
    memberships.length === 1 ? activeOrganizationSentenceName(memberships[0], memberships) : null;

  return (
    <div className="mx-auto w-full max-w-sm" data-testid="back-office-choice">
      <Card className="space-y-4">
        <div>
          <h1 className="text-h3 font-bold text-text-primary">
            You signed in with an admin account
          </h1>
          <p className="mt-1.5 text-[0.9375rem] text-text-muted">
            The admin console is where you run the platform. It asks you to sign in again, with your
            authenticator code.
          </p>
        </div>
        <Button className="w-full" onClick={() => void openAdmin()} autoFocus>
          Open the admin console
        </Button>
        <Button variant="outline" className="w-full" onClick={() => router.replace(next)}>
          {orgName ? `Continue to ${orgName} workspace` : 'Continue to the organizer workspace'}
        </Button>
        <p className="text-caption text-text-muted">
          {orgName
            ? `Your account is also a member of ${orgName}. Choose its workspace to manage its events.`
            : 'Your account is also a member of organizations here. Choose the workspace to manage their events.'}
        </p>
      </Card>
    </div>
  );
}

export default function BackOfficePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background-canvas p-4">
      <RequireAuth>
        <Suspense fallback={<Spinner />}>
          <BackOfficeInner />
        </Suspense>
      </RequireAuth>
    </div>
  );
}
