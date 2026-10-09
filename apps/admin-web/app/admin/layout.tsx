'use client';

import { RequireAuth } from '@eticketsgo/web-kit';
import { AdminShell } from '@/components/admin-shell';

/*
  The menu itself lives in `lib/admin-nav.ts`, grouped by the job an operator is doing, and the
  frame in `components/admin-shell.tsx`. The guard is unchanged: the admin console is for the
  ADMIN and SUPER_ADMIN roles, and each page and API route keeps its own capability check.
*/
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth roles={['ADMIN', 'SUPER_ADMIN']}>
      <AdminShell>{children}</AdminShell>
    </RequireAuth>
  );
}
