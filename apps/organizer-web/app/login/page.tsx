'use client';

import { LoginForm } from '@eticketsgo/web-kit';

export default function OrganizerLogin() {
  return (
    <LoginForm
      title="Organizer sign in"
      subtitle="Manage your events, orders, and payouts."
      defaultRedirect="/organizer"
      // Credentials were right; the account just has no organization yet. Previously this
      // refused them and cleared the session, which left no way to ever get in.
      roleMismatchRedirect="/start"
      allowedRoles={[
        'ORGANIZER_OWNER',
        'ORGANIZER_MANAGER',
        'CHECKIN_STAFF',
        'ADMIN',
        'SUPER_ADMIN',
      ]}
    />
  );
}
