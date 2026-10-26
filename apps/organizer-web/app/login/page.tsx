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
      /*
        Mobile beside Email. A phone-only account - the commonest kind on the storefront - has
        no email or password, and this page used to offer nothing else, so a customer who had
        just become an organizer could not get in (production, 2026-10-25).
      */
      phoneSignIn
      /*
        The seamless way: the storefront mints a one-time code for the account already signed in
        there and comes back to /handoff with it. Only a link to the storefront page that does
        that - never a token, and nothing that works without signing in on one side or the other.
      */
      alternate={
        store ? (
          <div className="border-t border-border pt-4">
            <a
              href={`${store}/account/organizer-console`}
              data-testid="continue-with-storefront"
              className="flex min-h-11 w-full items-center justify-center rounded-lg border border-border-input bg-background-surface px-4 text-[0.9375rem] font-semibold text-text-primary hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Continue with your ETicketsGo account
            </a>
            <p className="mt-2 text-center text-caption text-text-muted">
              Already signed in on the ETicketsGo website? This opens the console with that account.
            </p>
          </div>
        ) : null
      }
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
