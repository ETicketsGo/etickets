'use client';

import { useEffect, useState } from 'react';
import { LoginForm } from '@eticketsgo/web-kit';
import { storefrontOrigin } from '@/lib/storefront-url';

const LINK =
  'font-semibold text-text-primary underline underline-offset-4 hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export default function OrganizerLogin() {
  /*
    The storefront's address depends on where this console is served, which the server render
    cannot know; it is worked out after mount and the links appear then.
  */
  const [store, setStore] = useState<string | null>(null);
  useEffect(() => setStore(storefrontOrigin(window.location)), []);

  return (
    <LoginForm
      product="Organizer"
      title="Organizer sign in"
      subtitle="Manage your events, orders, and payouts."
      defaultRedirect="/organizer"
      // Credentials were right; the account just has no organization yet. Previously this
      // refused them and cleared the session, which left no way to ever get in.
      roleMismatchRedirect="/start"
      // An administrator is offered the admin console first, not dropped into an organization.
      backOfficePath="/back-office"
      allowedRoles={[
        'ORGANIZER_OWNER',
        'ORGANIZER_MANAGER',
        'CHECKIN_STAFF',
        'ADMIN',
        'SUPER_ADMIN',
      ]}
      /*
        The two ways out a sign-in page needs. This one had neither: a new organizer who came
        here first could not find where to register, and an owner who forgot a password had no
        reset. Both live on the storefront, with the same account.
      */
      footer={
        store ? (
          <>
            <p className="text-text-muted">
              <a className={LINK} href={`${store}/forgot-password`}>
                Forgot your password?
              </a>
            </p>
            <p className="text-text-muted">
              New to ETicketsGo?{' '}
              <a className={LINK} href={`${store}/register?intent=organizer`}>
                Create an organizer account
              </a>
            </p>
          </>
        ) : null
      }
    />
  );
}
