'use client';

import { LoginForm } from '@eticketsgo/web-kit';

export default function OrganizerLogin() {
  return (
    <LoginForm
      title="Organizer sign in"
      subtitle="Manage your events, orders, and payouts."
      defaultEmail="owner@eticketsgo.test"
      defaultRedirect="/organizer"
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
