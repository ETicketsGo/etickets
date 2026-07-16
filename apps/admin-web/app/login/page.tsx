'use client';

import { LoginForm } from '@eticketsgo/web-kit';

export default function AdminLogin() {
  return (
    <LoginForm
      title="Admin sign in"
      subtitle="Platform administration console."
      defaultRedirect="/admin"
      allowedRoles={['ADMIN', 'SUPER_ADMIN']}
    />
  );
}
